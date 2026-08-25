/**
 * The `agent-scan` scan provider.
 *
 * Lets a user enforce model domains the TypeScript scanner cannot see: any
 * language, docs, configs, infra files, anything. The instructions describe
 * in prose what to observe, defaulting to `DEFAULT_INSTRUCTIONS`, the general
 * import scan, so `agentScan({ exec })` works out of the box on a repository
 * in any language. The agent explores the repository read-only
 * (`agentic: true`), and its observations feed the same deterministic resolve
 * and validate phases as any other scanner's. The prefilled context is only
 * the instructions plus a bounded file listing, so it is deterministic and
 * `cached()` replays a rerun with unchanged inputs byte for byte.
 *
 * A listing larger than `batchFiles` splits into consecutive batches, one
 * call each, because a reply that must carry a whole repository dies at any
 * timeout. The batches are deterministic slices of the sorted listing, so
 * with `cached()` every completed batch is recorded as it finishes: progress
 * lands incrementally, and a failed or interrupted scan resumes at the first
 * unanswered batch instead of starting over.
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

import { pathMatcher } from '../globs.ts'
import { count, elapsed } from '../report.ts'
import type { Evidence, JsonObject, NamedProvider, Observation, Ref, ScanContext, ScanProvider } from '../types.ts'
import { assemblePack, DEFAULT_PACK_BUDGET_BYTES, fencedExcerpt } from './context-pack.ts'
import { schemaMismatch, seconds, truncate } from './exec.ts'
import type { AgentExec } from './exec.ts'

export const PROVIDER_ID = 'agent-scan'

/** How the shared path grammar's errors name this provider's option. */
const FOCUS_LABEL = 'Agent scan focus'

/**
 * The instructions `agentScan` runs with when the user writes none: the
 * general import scan, language-neutral on purpose. This is the scan every
 * first user of a non-TypeScript repository was hand-writing in their own
 * words (and at their own model's quality), so the tool ships it: files as
 * `file` observations, imports as `dependency` observations with `file`
 * targets inside the repository and `module` targets outside it, standard
 * library and generated code skipped. Exported so a config can extend it
 * rather than restate it.
 */
export const DEFAULT_INSTRUCTIONS =
  'Map the source code as a language-neutral dependency graph, whatever the language. ' +
  "Emit one 'file' observation for every source file you read. " +
  "Emit one 'dependency' observation for every import, include, require, or use declaration: " +
  "subject is the importing file; target is { kind: 'file' } with the imported file's " +
  'repository-relative path when the import stays inside this repository, or ' +
  "{ kind: 'module' } with the package name as written when it names an external package. " +
  'When a repository-local import points at a file you cannot find, emit ' +
  "'unresolved-dependency' with the specifier as written in a { kind: 'module' } target " +
  "instead of guessing a path. Skip imports of the language's own standard library: they " +
  'are part of the runtime, not of this architecture. Skip generated code, vendored ' +
  'dependencies, lockfiles, and build output entirely. ' +
  'Cite the file and line of each import as evidence.'

export interface AgentScanOptions {
  exec: AgentExec
  /**
   * What to observe, in prose, for a domain the general import scan does not
   * cover. For example: "read docker-compose.yml and emit a dependency
   * observation for each service-to-service link". Default:
   * `DEFAULT_INSTRUCTIONS`, the general import scan, so `agentScan({ exec })`
   * is a working scanner for a repository in any language.
   */
  instructions?: string
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
  /**
   * Hard budget for this scan's one call. Default: 10 minutes, overriding the
   * adapter's default, because a scan is the big call of a run: an agentic
   * exploration of a real repository takes minutes, and so can a one-shot
   * answering over a full context pack. The adapter's `timeoutMs` keeps
   * governing the small extraction calls the other providers make.
   */
  timeoutMs?: number
  /**
   * Files covered per call. A listing larger than this splits into
   * consecutive batches, one call each, because one reply cannot honestly
   * carry a whole repository: the reply grows with every file covered, and a
   * single call was measured dying on real repositories at any timeout. Each
   * batch is a deterministic request, so with `cached()` every completed
   * batch is recorded as it finishes and an interrupted scan resumes where it
   * stopped instead of starting over. Progress narrates per batch.
   */
  batchFiles?: number
}

const DEFAULT_MAX_FILES = 300
const DEFAULT_EXCERPT_CHARS = 4_000
const DEFAULT_SCAN_TIMEOUT_MS = 600_000
const DEFAULT_BATCH_FILES = 25

/** Cadence of the "still waiting" narration during the one long call. */
const PROGRESS_TICK_MS = 30_000

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
  "A ref of kind file may append '#<fragment>' to scope itself to a region inside the file, but " +
  'only where the scan instructions define such locators; the path before the # must still exist. ' +
  'List in `examined` every file you actually read; do not list files you did not open. ' +
  'An empty `examined` is treated as a failed scan.'

/**
 * Appended to the prompt in agentic mode only. Live measurement (see
 * `evals/fixtures/python`) showed a model that cannot ask for its working
 * directory inventing an absolute prefix for the listed paths, feeding it to
 * its read tool, and giving up when the guessed paths were denied. The tools
 * resolve the listed paths as they are; the model just has to be told so.
 */
const EXPLORATION_NOTE =
  ' Your working directory is the repository root, so every tool accepts the ' +
  'repository-relative paths exactly as listed in the context. Pass them as written; never ' +
  'prefix them with a guessed absolute directory.'

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  const instructions = options.instructions ?? DEFAULT_INSTRUCTIONS
  const batchFiles = options.batchFiles ?? DEFAULT_BATCH_FILES

  const run: ScanProvider = async (context: ScanContext): Promise<Observation[]> => {
    if (batchFiles < 1) {
      throw new Error(`agentScan batchFiles must be at least 1, got ${batchFiles}`)
    }
    const files = enumerateFiles(context.repositoryRoot, roots)

    // The files the scan covers: the whole listing, or what the focus globs
    // match, capped by maxFiles either way (the cap is announced, never
    // silent). These chunk into batches of `batchFiles`, one call each: the
    // requests are deterministic slices of a sorted listing, so `cached()`
    // records each completed batch and a rerun resumes at the first
    // unanswered one.
    let covered: string[]
    let dropped: number
    if (options.focus === undefined) {
      covered = files.slice(0, maxFiles)
      dropped = Math.max(0, files.length - maxFiles)
    } else {
      const matched = files.filter(pathMatcher(options.focus, FOCUS_LABEL))
      if (matched.length === 0) {
        throw new Error(
          `Agent scan focus [${options.focus.join(', ')}] matched no files under the scanned roots. ` +
            'A scan of nothing must not look like a clean one',
        )
      }
      covered = matched.slice(0, maxFiles)
      dropped = matched.length - covered.length
    }

    const batches: string[][] = []
    for (let start = 0; start < covered.length; start += batchFiles) {
      batches.push(covered.slice(start, start + batchFiles))
    }

    const guard = pathGuard(context.repositoryRoot)
    const examined = new Set<string>()
    const replies: ReplyObservation[][] = []

    for (const [index, batch] of batches.entries()) {
      // With a single batch the request is byte-identical to the unbatched
      // form, so recorded caches and pinned contexts stay valid.
      const batchInfo = batches.length === 1 ? undefined : { index: index + 1, total: batches.length }
      const batchDropped = index === batches.length - 1 ? dropped : 0

      // Two shapes of request. Without `focus`: the listing plus read-only
      // exploration. With `focus`: the matched files' contents are embedded
      // and the call is one-shot with no `agentic` flag at all, so the reply
      // can only come from the prefilled context, and the contents are in the
      // `cached()` key.
      const request =
        options.focus === undefined
          ? {
              prompt: PROMPT + EXPLORATION_NOTE,
              context: composeContext(instructions, roots, batch, batchDropped, batchInfo),
              schema: REPLY_SCHEMA,
              agentic: true as const,
              cwd: context.repositoryRoot,
              timeoutMs,
            }
          : {
              prompt: PROMPT,
              context: composeFocusedContext(
                context.repositoryRoot,
                instructions,
                roots,
                batch,
                batchDropped,
                excerptChars,
                batchInfo,
              ),
              schema: REPLY_SCHEMA,
              cwd: context.repositoryRoot,
              timeoutMs,
            }

      // Announce the call before it starts: agent calls are the slow part of
      // a run, and which shape (and roughly how much) is being sent says why.
      const prefix = batchInfo === undefined ? '' : `batch ${batchInfo.index} of ${batchInfo.total}: `
      context.progress?.(
        options.focus === undefined
          ? `${prefix}exploring the repository with ${options.exec.id}, ${count(batch.length, 'file')} listed`
          : `${prefix}asking ${options.exec.id} one-shot, about ${roughKilobytes(request.context)} of instructions and excerpts`,
      )

      // Each call is minutes long on a real repository, with nothing on the
      // wire until the CLI finishes. A quiet line on a fixed cadence keeps
      // that wait distinguishable from a hang, and names the budget so a
      // reader knows when the hard stop comes.
      const started = Date.now()
      const ticker = setInterval(() => {
        context.progress?.(`still waiting on ${options.exec.id}, ${elapsed(started)} of the ${seconds(timeoutMs)} budget`)
      }, PROGRESS_TICK_MS)
      ticker.unref?.()

      let reply
      try {
        reply = await options.exec.run(request)
      } finally {
        clearInterval(ticker)
      }

      if (!reply.ok) {
        const where = batchInfo === undefined ? '' : ` on batch ${batchInfo.index} of ${batchInfo.total}`
        const resume =
          batchInfo === undefined
            ? ''
            : '. Completed batches replay from the cache on a rerun when the exec is wrapped in cached()'
        throw new Error(`Agent scan was unavailable (${options.exec.id})${where}: ${reply.error}${resume}`)
      }

      // The exec layer already enforced the schema on a live reply, but this
      // provider must not trust the transport it was handed: a custom adapter
      // or a stale cache entry recorded against an older schema would
      // otherwise flow malformed entries into the pipeline as observations.
      const mismatch = schemaMismatch(reply.value, REPLY_SCHEMA)
      if (mismatch !== undefined) {
        throw new Error(`Agent scan reply did not match the requested schema: ${mismatch}`)
      }

      const parsed = reply.value as unknown as {
        observations: ReplyObservation[]
        examined: string[]
      }

      // Attestation per batch: an empty `examined` fails before any
      // observation is considered, because observations without coverage are
      // unanchored claims, and a batch that read nothing scanned nothing.
      const attested = parsed.examined.map((entry) => guard(entry, 'examined'))
      if (attested.length === 0) {
        throw new Error(
          `Agent scan (${options.exec.id}) attested to examining no files. An absent scan must not look like a clean one`,
        )
      }
      for (const entry of attested) examined.add(entry)
      replies.push(parsed.observations)
    }

    const observations: Observation[] = []
    const usedIds = new Set<string>()

    for (const filePath of [...examined].sort()) {
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

    // Within one reply, two identical claims are two facts and stay distinct
    // by ordinal. Across batches, an identical claim is overlap: a model that
    // read a neighboring file for context re-reported it, and the repeat
    // must not double the observation.
    const reportedEarlier = new Set<string>()
    for (const batchEntries of replies) {
      const reportedHere = new Set<string>()
      for (const entry of batchEntries) {
        const converted = toObservation(entry, guard, usedIds, reportedEarlier, options.exec.id, providerId)
        if (converted === undefined) continue
        reportedHere.add(naturalKeyOf(converted))
        observations.push(converted)
      }
      for (const key of reportedHere) reportedEarlier.add(key)
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
 * Convert one reply entry into a standard `Observation`, or undefined when an
 * earlier batch already reported the identical claim.
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
  reportedEarlier: Set<string>,
  execId: string,
  providerId: string,
): Observation | undefined {
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
  if (reportedEarlier.has(naturalKey)) return undefined
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

/** The same natural key `toObservation` derives, recomputed from a converted observation. */
function naturalKeyOf(observation: Observation): string {
  const subject = observation.subject?.id ?? ''
  const target = observation.target === undefined ? '' : `->${observation.target.id}`
  return `${observation.kind}:${subject}${target}`
}

/**
 * Refs of kind `file` or `directory` carry paths; other kinds pass through.
 *
 * A `file` ref may scope its id to a region inside the file with a fragment
 * locator (`<path>#<fragment>`), for scan instructions whose subjects share
 * one file. The path part goes through the hallucination guard like any other
 * path; the fragment rides along as an opaque locator for ownership
 * resolution, not a filesystem claim.
 */
function guardedRef(ref: { kind: string; id: string }, guard: PathGuard, where: string): Ref {
  if (ref.kind === 'file' || ref.kind === 'directory') {
    const hash = ref.kind === 'file' ? ref.id.indexOf('#') : -1
    if (hash > 0 && hash < ref.id.length - 1) {
      return { kind: ref.kind, id: `${guard(ref.id.slice(0, hash), where)}${ref.id.slice(hash)}` }
    }
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

interface BatchInfo {
  index: number
  total: number
}

/** The batch framing lines, absent entirely for a single-batch scan. */
function batchHeading(batchInfo: BatchInfo | undefined): string {
  return batchInfo === undefined ? '' : `, batch ${batchInfo.index} of ${batchInfo.total}`
}

function batchNote(batchInfo: BatchInfo | undefined): string {
  if (batchInfo === undefined) return ''
  return (
    '\n\nNOTE: this is one batch of a larger scan. Carry out the scan instructions against the ' +
    'files listed above; the other batches cover the rest, so do not report observations about ' +
    'files outside this listing unless the scan instructions specifically name them.'
  )
}

function composeContext(
  instructions: string,
  roots: string[],
  listed: string[],
  dropped: number,
  batchInfo?: BatchInfo,
): string {
  const parts = [
    `### Scan instructions\n\n${instructions}`,
    `### Repository files under ${roots.join(', ')} (repository-relative${batchHeading(batchInfo)})\n\n` +
      listed.map((file) => `- ${file}`).join('\n') +
      (dropped > 0
        ? `\n\nNOTE: this listing is truncated — ${dropped} more files exist under the scanned roots and are not listed. You may still read and report them.`
        : '') +
      batchNote(batchInfo),
  ]
  return parts.join('\n\n')
}

/**
 * The focused, one-shot context: instructions plus code-first excerpts of one
 * batch of the files the focus globs matched, assembled as a context pack.
 *
 * Matches beyond `maxFiles` or the pack's byte budget are announced inline,
 * never silently thinned; since the one-shot request has no tools, an
 * unexcerpted file is a file the model genuinely cannot see, and it must
 * know that.
 */
function composeFocusedContext(
  repositoryRoot: string,
  instructions: string,
  roots: string[],
  shown: string[],
  alreadyDropped: number,
  excerptChars: number,
  batchInfo?: BatchInfo,
): string {
  const pack = assemblePack(
    [
      { header: `### Scan instructions\n\n${instructions}`, items: [], what: 'instructions' },
      {
        header:
          `### Focused files under ${roots.join(', ')} (repository-relative${batchHeading(batchInfo)})\n\n` +
          'Answer from these excerpts alone; they are your entire view of the repository.' +
          batchNote(batchInfo),
        items: shown.map(
          (file) => `### ${file}\n${fencedExcerpt(repositoryRoot, file, excerptChars)}`,
        ),
        what: 'focused files',
        alreadyDropped,
      },
    ],
    DEFAULT_PACK_BUDGET_BYTES,
  )
  return pack.text
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

/** A rough size for narration: whole kilobytes, never zero. */
function roughKilobytes(text: string): string {
  return `${Math.max(1, Math.round(Buffer.byteLength(text, 'utf8') / 1024))} KB`
}
