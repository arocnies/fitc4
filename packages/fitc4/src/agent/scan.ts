/**
 * The `agent-scan` scan provider.
 *
 * Lets a user enforce model domains the TypeScript scanner cannot see — docs,
 * configs, infra files, anything — by describing in prose what to observe. The
 * user writes instructions, the agent explores the repository read-only
 * (`agentic: true`), and its observations feed the same deterministic resolve
 * and validate phases as any other scanner's. The prefilled context is
 * deterministic — the instructions plus a bounded file listing — so `cached()`
 * replays a rerun with unchanged inputs byte for byte.
 *
 * **Fail-closed, deliberately stricter than the advisory validate providers.**
 * The agent validate providers degrade to a visible `agent-unavailable` finding
 * because their judgment is an enrichment: every deterministic finding still
 * stands without them. A scanner is load-bearing — its observations are the
 * coverage the rules judge — so an absent scanner must never look like a clean
 * scan. Any exec failure, off-schema reply, hallucinated path, or empty
 * `examined` attestation therefore THROWS, which the pipeline reports as one
 * `provider-failure` error finding attributed to this provider.
 *
 * Coverage attestation: the reply's required `examined` array names the files
 * the model actually read, and each becomes a standard `scan-root`
 * observation. An empty `examined` is a failure, not a pass — a scan that
 * read nothing observed nothing, and zero observations must not read as a
 * clean domain.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Evidence, JsonObject, NamedProvider, Observation, Ref, ScanContext, ScanProvider } from '../types.ts'
import { schemaMismatch, truncate } from './exec.ts'
import type { AgentExec } from './exec.ts'

export const PROVIDER_ID = 'agent-scan'

export interface AgentScanOptions {
  exec: AgentExec
  /**
   * What to observe, in prose — e.g. "read docker-compose.yml and emit a
   * dependency observation for each service-to-service link".
   */
  instructions: string
  /**
   * Repository-relative directories whose files are listed in the prefilled
   * context. Default: the repository root. These bound the listing, not the
   * exploration — the model may still read any repository file it names in
   * `examined`.
   */
  roots?: string[]
  /**
   * Suffix for the provider id: `agent-scan:<id>` instead of `agent-scan`.
   *
   * The pipeline namespaces every observation id with the provider id it was
   * composed under, so two instances with different instructions coexist only
   * when their provider ids differ — give each instance its own `id`.
   */
  id?: string
  /** Files listed in the context; a longer listing is announced as truncated. */
  maxFiles?: number
}

const DEFAULT_MAX_FILES = 300

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

  const run: ScanProvider = async (context: ScanContext): Promise<Observation[]> => {
    const files = enumerateFiles(context.repositoryRoot, roots)
    const listed = files.slice(0, maxFiles)
    const dropped = files.length - listed.length

    const reply = await options.exec.run({
      prompt: PROMPT,
      context: composeContext(options.instructions, roots, listed, dropped),
      schema: REPLY_SCHEMA,
      agentic: true,
      cwd: context.repositoryRoot,
    })

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
        `Agent scan (${options.exec.id}) attested to examining no files — an absent scan must not look like a clean one`,
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
 * Kinds outside the standard set are legal — the `unknown-observation-kind`
 * rule reports them at info — but every path must survive the hallucination
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
 * disk. Anything else throws — a path that fails the guard is a claim about
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
 * Every file under the roots, as sorted repository-relative POSIX paths.
 *
 * Unlike the TypeScript scanner this lists all file types — docs, configs,
 * infra — because unseen file types are exactly what this provider exists
 * for. Hidden entries and `node_modules` are skipped. A root that does not
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
