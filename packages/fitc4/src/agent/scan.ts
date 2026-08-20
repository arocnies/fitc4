/**
 * The `agent-scan` scan provider.
 *
 * Lets a user enforce model domains the TypeScript scanner cannot see: docs,
 * configs, infra files, anything. The user writes instructions describing in
 * prose what to observe, the agent explores the repository read-only
 * (`agentic: true`), and its observations feed the same deterministic resolve
 * and validate phases as any other scanner's. The prefilled context is only
 * the instructions plus a bounded file listing, so it is deterministic and
 * `cached()` replays a rerun with unchanged inputs byte for byte.
 *
 * With `focus`, the provider prefills instead of exploring: the files the
 * globs match are embedded as code-first excerpts and the request drops
 * `agentic` entirely. What is left is a one-shot call answered from the
 * context alone. Prefilling also closes the agentic mode's cache-staleness
 * hole: file *contents* enter the request, so they enter the `cached()` key,
 * and an edit to a focused file invalidates the recorded reply instead of
 * replaying a stale one. Exploration only ever keyed on the listing.
 *
 * **Fail-closed, deliberately stricter than the advisory validate providers.**
 * The agent validate providers degrade to a visible `agent-unavailable` finding
 * because their judgment is an enrichment: every deterministic finding still
 * stands without them. A scanner is load-bearing. Its observations are the
 * coverage the rules judge, so an absent scanner must never look like a clean
 * scan. Any exec failure, off-schema reply, hallucinated path, or empty
 * `examined` attestation therefore THROWS, which the pipeline reports as one
 * `provider-failure` error finding attributed to this provider.
 *
 * Coverage attestation: the reply's required `examined` array names the files
 * the model actually read, and each becomes a standard `scan-root`
 * observation. An empty `examined` is a failure, not a pass. A scan that
 * read nothing observed nothing, and zero observations must not read as a
 * clean domain.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Evidence, JsonObject, NamedProvider, Observation, Ref, ScanContext, ScanProvider } from '../types.ts'
import { assemblePack, DEFAULT_PACK_BUDGET_BYTES, fencedExcerpt } from './context-pack.ts'
import { schemaMismatch, truncate } from './exec.ts'
import type { AgentExec } from './exec.ts'

export const PROVIDER_ID = 'agent-scan'

export interface AgentScanOptions {
  exec: AgentExec
  /**
   * What to observe, in prose. For example: "read docker-compose.yml and emit
   * a dependency observation for each service-to-service link".
   */
  instructions: string
  /**
   * Repository-relative directories whose files are listed in the prefilled
   * context. Default: the repository root. These bound the listing, not the
   * exploration. The model may still read any repository file it names in
   * `examined`.
   */
  roots?: string[]
  /**
   * Suffix for the provider id: `agent-scan:<id>` instead of `agent-scan`.
   *
   * The pipeline namespaces every observation id with the provider id it was
   * composed under, so two instances with different instructions coexist only
   * when their provider ids differ. Give each instance its own `id`.
   */
  id?: string
  /** Files listed in the context; a longer listing is announced as truncated. */
  maxFiles?: number
  /**
   * Focus globs over the enumerated listing (`*` within a path segment,
   * `**` across segments; a bare path matches itself or its directory
   * subtree, like a `sources` prefix). When set, the matched files are
   * embedded as code-first excerpts and the request is one-shot, with no
   * `agentic` exploration. Because the file CONTENTS are then part of the
   * request, they are part of the `cached()` key too, which closes the
   * agentic mode's staleness hole: an edit to a focused file invalidates the
   * recorded reply. A focus that matches nothing fails loudly. A scan of
   * zero files must not look like a clean domain. Matches beyond `maxFiles`
   * or the byte budget are announced in the context as not shown.
   */
  focus?: string[]
  /** Characters of each focused file embedded in the context, code-first. */
  excerptChars?: number
}

const DEFAULT_MAX_FILES = 300
const DEFAULT_EXCERPT_CHARS = 4_000

/** Never listed, at any depth. */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

const REF_SCHEMA: JsonObject = {
  type: 'object',
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string' },
    id: { type: 'string' },
  },
}

const REPLY_SCHEMA: JsonObject = {
  type: 'object',
  required: ['observations', 'examined'],
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'subject'],
        properties: {
          kind: { type: 'string' },
          subject: REF_SCHEMA,
          target: REF_SCHEMA,
          description: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path'],
              properties: {
                path: { type: 'string' },
                line: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    examined: { type: 'array', items: { type: 'string' } },
  },
}

const PROMPT =
  'Carry out the scan instructions in the context against this repository. ' +
  'Report each fact you observe as one observation: `kind` names what kind of fact it is ' +
  "(prefer the standard kinds 'file', 'dependency', 'unresolved-dependency' where they fit; " +
  'a domain-specific kind is allowed), `subject` is what the fact is about, `target` is what ' +
  'it points at (for dependency-shaped facts), and `evidence` cites where you saw it. ' +
  'Every path — in refs of kind file or directory, in evidence, and in examined — must be a ' +
  'repository-relative POSIX path to something that exists in this repository. ' +
  'List in `examined` every file you actually read; do not list files you did not open. ' +
  'An empty `examined` is treated as a failed scan.'

/**
 * An agent-driven scan provider: prose instructions in, standard observations out.
 *
 * See the module JSDoc for the fail-closed contract. Compose the exec with
 * `cached()` to make reruns with unchanged instructions and listing free.
 */
export function agentScan(options: AgentScanOptions): NamedProvider<ScanProvider> {
  const providerId = options.id === undefined ? PROVIDER_ID : `${PROVIDER_ID}:${options.id}`
  const roots = options.roots ?? ['.']
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES

  const excerptChars = options.excerptChars ?? DEFAULT_EXCERPT_CHARS

  const run: ScanProvider = async (context: ScanContext): Promise<Observation[]> => {
    const files = enumerateFiles(context.repositoryRoot, roots)

    // Two shapes of request. Without `focus`: the listing plus read-only
    // exploration, unchanged. With `focus`: the matched files' contents are
    // embedded and the call is one-shot with no `agentic` flag at all, so the
    // reply can only come from the prefilled context, and the contents are in
    // the `cached()` key.
    const request =
      options.focus === undefined
        ? {
            prompt: PROMPT,
            context: composeContext(
              options.instructions,
              roots,
              files.slice(0, maxFiles),
              Math.max(0, files.length - maxFiles),
            ),
            schema: REPLY_SCHEMA,
            agentic: true as const,
            cwd: context.repositoryRoot,
          }
        : {
            prompt: PROMPT,
            context: composeFocusedContext(
              context.repositoryRoot,
              options.instructions,
              roots,
              files,
              options.focus,
              maxFiles,
              excerptChars,
            ),
            schema: REPLY_SCHEMA,
            cwd: context.repositoryRoot,
          }

    const reply = await options.exec.run(request)

    if (!reply.ok) {
      throw new Error(`Agent scan was unavailable (${options.exec.id}): ${reply.error}`)
    }

    // The exec layer already enforced the schema on a live reply, but this
    // provider must not trust the transport it was handed: a custom adapter or
    // a stale cache entry recorded against an older schema would otherwise
    // flow malformed entries into the pipeline as observations.
    const mismatch = schemaMismatch(reply.value, REPLY_SCHEMA)
    if (mismatch !== undefined) {
      throw new Error(`Agent scan reply did not match the requested schema: ${mismatch}`)
    }

    const parsed = reply.value as unknown as {
      observations: ReplyObservation[]
      examined: string[]
    }

    const guard = pathGuard(context.repositoryRoot)

    // Attestation first: an empty `examined` fails before any observation is
    // considered, because observations without coverage are unanchored claims.
    const examined = [...new Set(parsed.examined.map((entry) => guard(entry, 'examined')))].sort()
    if (examined.length === 0) {
      throw new Error(
        `Agent scan (${options.exec.id}) attested to examining no files. An absent scan must not look like a clean one`,
      )
    }

    const observations: Observation[] = []
    const usedIds = new Set<string>()

    for (const filePath of examined) {
      const id = `scan-root:${filePath}`
      usedIds.add(id)
      observations.push({
        id,
        kind: 'scan-root',
        subject: { kind: 'file', id: filePath },
        description: `${filePath} was examined by the agent scan`,
        data: { agent: options.exec.id },
        provider: providerId,
      })
    }

    for (const entry of parsed.observations) {
      observations.push(toObservation(entry, guard, usedIds, options.exec.id, providerId))
    }

    return observations
  }

  return { id: providerId, run }
}

interface ReplyObservation {
  kind: string
  subject: { kind: string; id: string }
  target?: { kind: string; id: string }
  description?: string
  evidence?: { path: string; line?: number }[]
}

/**
 * Convert one reply entry into a standard `Observation`.
 *
 * Kinds outside the standard set are legal, and the `unknown-observation-kind`
 * rule reports them at info. But every path must survive the hallucination
 * guard: repo-relative, inside the repository, present on disk. A nonexistent
 * path fails the provider (visible), never gets silently dropped.
 */
function toObservation(
  entry: ReplyObservation,
  guard: PathGuard,
  usedIds: Set<string>,
  execId: string,
  providerId: string,
): Observation {
  if (entry.kind.trim() === '') {
    throw new Error('Agent scan reply contained an observation with an empty kind')
  }

  const subject = guardedRef(entry.subject, guard, 'subject')
  const target = entry.target === undefined ? undefined : guardedRef(entry.target, guard, 'target')
  const evidence = entry.evidence?.map(
    (item): Evidence => ({
      path: guard(item.path, 'evidence'),
      ...(item.line === undefined ? {} : { line: item.line }),
    }),
  )

  // Natural-key ids per the ids convention; an ordinal keeps two identical
  // claims distinct instead of tripping the pipeline's duplicate-id check.
  const naturalKey = `${entry.kind}:${subject.id}${target === undefined ? '' : `->${target.id}`}`
  let id = naturalKey
  for (let ordinal = 1; usedIds.has(id); ordinal += 1) {
    id = `${naturalKey}#${ordinal}`
  }
  usedIds.add(id)

  return {
    id,
    kind: entry.kind,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    subject,
    ...(target === undefined ? {} : { target }),
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence }),
    data: { agent: execId },
    provider: providerId,
  }
}

/** Refs of kind `file` or `directory` carry paths; other kinds pass through. */
function guardedRef(ref: { kind: string; id: string }, guard: PathGuard, where: string): Ref {
  if (ref.kind === 'file' || ref.kind === 'directory') {
    return { kind: ref.kind, id: guard(ref.id, where) }
  }
  return { kind: ref.kind, id: ref.id }
}

type PathGuard = (candidate: string, where: string) => string

/**
 * The hallucination guard: normalize a model-reported path and verify it is
 * repository-relative, does not escape the repository root, and exists on
 * disk. Anything else throws. A path that fails the guard is a claim about
 * code that is not there, and dropping it silently would let the rest of the
 * reply pass as trustworthy.
 */
function pathGuard(repositoryRoot: string): PathGuard {
  const root = path.resolve(repositoryRoot)

  return (candidate, where) => {
    const reject = (reason: string): never => {
      throw new Error(`Agent scan reply named an invalid path in ${where}: '${truncate(candidate, 120)}' ${reason}`)
    }

    if (candidate.trim() === '') reject('is empty')
    if (path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
      reject('is not repository-relative')
    }

    const absolute = path.resolve(root, candidate)
    const relative = path.relative(root, absolute)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      reject('escapes the repository root')
    }
    if (!fs.existsSync(absolute)) reject('does not exist in the repository')

    return toPosix(relative)
  }
}

function composeContext(
  instructions: string,
  roots: string[],
  listed: string[],
  dropped: number,
): string {
  const parts = [
    `### Scan instructions\n\n${instructions}`,
    `### Repository files under ${roots.join(', ')} (repository-relative)\n\n` +
      listed.map((file) => `- ${file}`).join('\n') +
      (dropped > 0
        ? `\n\nNOTE: this listing is truncated — ${dropped} more files exist under the scanned roots and are not listed. You may still read and report them.`
        : ''),
  ]
  return parts.join('\n\n')
}

/**
 * The focused, one-shot context: instructions plus code-first excerpts of the
 * files the focus globs match, assembled as a context pack.
 *
 * A focus that matches nothing throws. Fail closed again: a scan over zero
 * files must not look like a clean domain. Matches beyond
 * `maxFiles` or the pack's byte budget are announced inline, never silently
 * thinned; since the one-shot request has no tools, an unexcerpted file is a
 * file the model genuinely cannot see, and it must know that.
 */
function composeFocusedContext(
  repositoryRoot: string,
  instructions: string,
  roots: string[],
  files: string[],
  focus: string[],
  maxFiles: number,
  excerptChars: number,
): string {
  const matches = focusMatcher(focus)
  const matched = files.filter(matches)
  if (matched.length === 0) {
    throw new Error(
      `Agent scan focus [${focus.join(', ')}] matched no files under the scanned roots. ` +
        'A scan of nothing must not look like a clean one',
    )
  }

  const shown = matched.slice(0, maxFiles)
  const pack = assemblePack(
    [
      { header: `### Scan instructions\n\n${instructions}`, items: [], what: 'instructions' },
      {
        header:
          `### Focused files under ${roots.join(', ')} (repository-relative)\n\n` +
          'Answer from these excerpts alone; they are your entire view of the repository.',
        items: shown.map(
          (file) => `### ${file}\n${fencedExcerpt(repositoryRoot, file, excerptChars)}`,
        ),
        what: 'focused files',
        alreadyDropped: matched.length - shown.length,
      },
    ],
    DEFAULT_PACK_BUDGET_BYTES,
  )
  return pack.text
}

/**
 * Match focus patterns against listing paths: `*` within a path segment,
 * `**` across segments, and a bare path matching itself or its directory
 * subtree. Those are the same prefix semantics `sources` metadata uses, so a
 * focus reads like the rest of the model's path vocabulary. Deliberately no
 * glob dependency: this is the whole grammar.
 */
function focusMatcher(patterns: string[]): (file: string) => boolean {
  if (patterns.length === 0) {
    throw new Error('Agent scan focus is empty; list at least one glob or path')
  }

  const tests = patterns.map((pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (normalized === '') {
      throw new Error(`Agent scan focus pattern '${pattern}' matches nothing it could name`)
    }
    if (!normalized.includes('*')) {
      return (file: string) => file === normalized || file.startsWith(`${normalized}/`)
    }
    const regExp = globToRegExp(normalized)
    return (file: string) => regExp.test(file)
  })

  return (file) => tests.some((test) => test(file))
}

function globToRegExp(glob: string): RegExp {
  let pattern = ''
  let index = 0
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:[^/]+/)*'
      index += 3
      continue
    }
    if (glob.startsWith('**', index)) {
      pattern += '.*'
      index += 2
      continue
    }
    const char = glob[index] ?? ''
    if (char === '*') {
      pattern += '[^/]*'
      index += 1
      continue
    }
    pattern += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
    index += 1
  }
  return new RegExp(`^${pattern}$`)
}

/**
 * Every file under the roots, as sorted repository-relative POSIX paths.
 *
 * Unlike the TypeScript scanner this lists every file type, docs and configs
 * and infra included, because unseen file types are exactly what this provider
 * exists for. The walk skips hidden entries and `node_modules`. A root that does not
 * exist, or holds no files, fails loudly: an empty listing silently reduces
 * the prompt's coverage to nothing.
 */
function enumerateFiles(repositoryRoot: string, roots: string[]): string[] {
  if (roots.length === 0) {
    throw new Error('no roots configured for the agent scan; there is nothing to list')
  }

  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      found.push(toPosix(path.relative(repositoryRoot, absolute)))
    }
  }

  for (const root of roots) {
    const absolute = path.resolve(repositoryRoot, root)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new Error(`Agent scan root '${root}' is not a directory`)
    }
    walk(absolute)
  }

  const files = [...new Set(found)].sort()
  if (files.length === 0) {
    throw new Error('the agent scan roots contain no files; there is nothing to observe')
  }
  return files
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
