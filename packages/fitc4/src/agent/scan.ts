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
 * A listing larger than `batchFiles` splits into batches, one call each,
 * because a reply that must carry a whole repository dies at any timeout.
 * The partition follows the directory tree: a directory whose subtree fits
 * in one batch stays whole, sibling directories pack together, and only a
 * directory too large for any batch splits, so each call covers one coherent
 * area instead of an alphabetical shard straddling modules. Batches run
 * `concurrency` at a time; they are disjoint by construction and each call
 * is its own session, so concurrency buys wall clock and changes nothing
 * else. The partition is a pure function of the sorted listing, so with
 * `cached()` every completed batch is recorded as it finishes: progress
 * lands incrementally, and a failed or interrupted scan resumes with the
 * finished batches replaying from the cache.
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
 * `provider-failure` error finding attributed to this provider. The one
 * carve-out is a dependency's `file` or `directory` target that names nothing
 * on disk: that is a failed resolution, not a coverage lie, so it downgrades
 * to an 'unresolved-dependency' the gate reports as a warning instead of
 * costing every completed batch.
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
   *
   * With `focus`, the roots do double duty: the focused files' contents are
   * embedded, and every other file under the roots is listed as a path with
   * no contents. That inventory is what lets a one-shot scan check a path
   * before reporting it, so widening the roots past the focused files is how
   * you tell a one-shot scan which paths exist. Cheap: paths, not contents.
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
   *
   * `focus` picks whose contents are embedded; `roots` picks whose paths are
   * known to exist. Set roots wider than focus when the instructions refer to
   * files outside the focused set, which is the usual shape: read the
   * manifests, refer to the directories they deploy.
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
   * Most files covered per call. A listing larger than this splits into
   * batches, one call each, because one reply cannot honestly carry a whole
   * repository: the reply grows with every file covered, and a single call
   * was measured dying on real repositories at any timeout. The partition
   * follows the directory tree (see `partitionListing`), so each call covers
   * one coherent area, and each batch is a deterministic request, so with
   * `cached()` every completed batch is recorded as it finishes and an
   * interrupted scan resumes where it stopped instead of starting over.
   * Progress narrates per batch.
   */
  batchFiles?: number
  /**
   * Batches in flight at once. Default: 4. The batches are disjoint areas by
   * construction and every call is its own session, so a concurrent run
   * produces exactly the observations a sequential one does; concurrency
   * only buys wall clock. Set 1 for a strictly sequential scan, for example
   * when the CLI account's rate limits push back.
   */
  concurrency?: number
}

const DEFAULT_MAX_FILES = 300
const DEFAULT_EXCERPT_CHARS = 4_000
const DEFAULT_SCAN_TIMEOUT_MS = 600_000
const DEFAULT_BATCH_FILES = 25
const DEFAULT_CONCURRENCY = 4

/** Cadence of the "still waiting" narration during the long calls. */
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
  'Report each fact you observe as one observation: `kind` names what kind of fact it is, ' +
  '`subject` is what the fact is about, `target` is what it points at (for dependency-shaped ' +
  'facts), and `evidence` cites where you saw it. Only the standard kinds are checked against ' +
  "the architecture model: 'file' for a source file, 'dependency' for one thing relying on " +
  "another, 'unresolved-dependency' for a reliance whose target you cannot locate. Whatever a " +
  "domain calls its dependencies — depends_on, an env var URL, a wired parameter, a documented " +
  "call — report each one under kind 'dependency'. A domain-specific kind is allowed for facts " +
  'that are genuinely none of these, and is recorded but never checked. ' +
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
    const concurrencyOption = options.concurrency ?? DEFAULT_CONCURRENCY
    if (concurrencyOption < 1) {
      throw new Error(`agentScan concurrency must be at least 1, got ${concurrencyOption}`)
    }
    const files = enumerateFiles(context.repositoryRoot, roots)

    // The files the scan covers: the whole listing, or what the focus globs
    // match, capped by maxFiles either way (the cap is announced, never
    // silent). These partition into batches along the directory tree, one
    // call each, `concurrency` at a time: the partition is a pure function of
    // the sorted listing, so `cached()` records each completed batch and a
    // rerun resumes at the first unanswered one.
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

    // The inventory is the rest of the listing: paths under the roots whose
    // contents no focus glob embedded. Only focused mode uses it, since
    // exploration already receives the full listing and can read what it
    // names.
    const coveredSet = new Set(covered)
    const inventory = options.focus === undefined ? [] : files.filter((file) => !coveredSet.has(file))

    const batches = partitionListing(covered, batchFiles)
    const concurrency = Math.min(concurrencyOption, batches.length)

    const guard = pathGuard(context.repositoryRoot)
    const replies: ReplyObservation[][] = new Array<ReplyObservation[]>(batches.length)
    const attestations: string[][] = new Array<string[]>(batches.length)

    // One in-flight registry feeding one ticker for the whole pool: a ticker
    // per call at concurrency 4 would narrate four interleaved waiting lines
    // every tick, noise exactly when someone is watching a long scan.
    const inFlight = new Map<number, number>()

    const runBatch = async (index: number): Promise<void> => {
      const batch = batches[index] ?? []
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
                inventory,
                batchInfo,
              ),
              schema: REPLY_SCHEMA,
              cwd: context.repositoryRoot,
              timeoutMs,
            }

      // Announce the call before it starts: agent calls are the slow part of
      // a run, and which area (and roughly how much) is being sent says why.
      const prefix = batchInfo === undefined ? '' : `batch ${batchInfo.index} of ${batchInfo.total}: `
      context.progress?.(
        options.focus === undefined
          ? `${prefix}exploring ${batchArea(batch)} with ${options.exec.id}, ${count(batch.length, 'file')} listed`
          : `${prefix}asking ${options.exec.id} one-shot, about ${roughKilobytes(request.context)} of instructions and excerpts`,
      )

      inFlight.set(index, Date.now())
      let reply
      try {
        reply = await options.exec.run(request)
      } finally {
        inFlight.delete(index)
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
        const where = batchInfo === undefined ? '' : ` on batch ${batchInfo.index} of ${batchInfo.total}`
        throw new Error(
          `Agent scan (${options.exec.id}) attested to examining no files${where}. An absent scan must not look like a clean one`,
        )
      }
      attestations[index] = attested
      replies[index] = parsed.observations
    }

    // Each call is minutes long on a real repository, with nothing on the
    // wire until the CLI finishes. A quiet line on a fixed cadence keeps that
    // wait distinguishable from a hang, and names the budget so a reader
    // knows when the hard stop comes.
    const ticker = setInterval(() => {
      if (inFlight.size === 0) return
      const budget = `${elapsed(Math.min(...inFlight.values()))} of the ${seconds(timeoutMs)} budget`
      if (batches.length === 1) {
        context.progress?.(`still waiting on ${options.exec.id}, ${budget}`)
        return
      }
      const positions = [...inFlight.keys()].sort((a, b) => a - b).map((position) => position + 1)
      const named = positions.length === 1 ? `batch ${positions[0]}` : `batches ${positions.join(', ')}`
      context.progress?.(
        `still waiting on ${options.exec.id}, ${named} of ${batches.length} in flight, ${budget}`,
      )
    }, PROGRESS_TICK_MS)
    ticker.unref?.()

    // A fixed pool over the batch list. On a failure the pool stops taking
    // new batches but lets in-flight siblings finish, so their replies land
    // in the cache and a rerun resumes further along; then the failure fails
    // the provider whole, fail-closed as ever.
    let failure: unknown
    let nextIndex = 0
    try {
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (failure === undefined) {
            const index = nextIndex
            nextIndex += 1
            if (index >= batches.length) return
            try {
              await runBatch(index)
            } catch (error) {
              failure ??= error
            }
          }
        }),
      )
    } finally {
      clearInterval(ticker)
    }
    if (failure !== undefined) throw failure

    const examined = new Set<string>()
    for (const attested of attestations) {
      for (const entry of attested ?? []) examined.add(entry)
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
    // must not double the observation. The merge walks batch order, never
    // completion order, so a concurrent run's output is identical to a
    // sequential one's.
    const reportedEarlier = new Set<string>()
    for (const [batchIndex, batchEntries] of replies.entries()) {
      const reportedHere = new Set<string>()
      for (const entry of batchEntries) {
        let converted: Observation | undefined
        try {
          converted = toObservation(entry, guard, usedIds, reportedEarlier, options.exec.id, providerId)
        } catch (error) {
          // Conversion failures happen after the pool, so without this the
          // error would not say which batch's reply carried the bad claim.
          if (batches.length > 1 && error instanceof Error) {
            error.message = `${error.message} (batch ${batchIndex + 1} of ${batches.length})`
          }
          throw error
        }
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

  // A dependency target that is well-formed but names no real file is a
  // failed resolution, not a coverage lie, and the reply contract has a shape
  // for exactly that: the claim downgrades to 'unresolved-dependency' with
  // the path as a module specifier, which the unresolved-import rule surfaces
  // as a warning. Failing the scan here would throw away every batch over one
  // dropped path segment (measured: a model wrote docs/assets/... for
  // docs/docs/assets/...). Subjects, evidence, and attestations stay
  // fail-closed: those are the claims that say what was covered.
  let kind = entry.kind
  let target = entry.target === undefined ? undefined : guardedTarget(entry, guard)
  if (entry.kind === 'dependency' && entry.target !== undefined && target === undefined) {
    kind = 'unresolved-dependency'
    target = { kind: 'module', id: entry.target.id }
  }

  const evidence = entry.evidence?.map(
    (item): Evidence => ({
      path: guard(item.path, 'evidence'),
      ...(item.line === undefined ? {} : { line: item.line }),
    }),
  )

  // Natural-key ids per the ids convention; an ordinal keeps two identical
  // claims distinct instead of tripping the pipeline's duplicate-id check.
  const naturalKey = `${kind}:${subject.id}${target === undefined ? '' : `->${target.id}`}`
  if (reportedEarlier.has(naturalKey)) return undefined
  let id = naturalKey
  for (let ordinal = 1; usedIds.has(id); ordinal += 1) {
    id = `${naturalKey}#${ordinal}`
  }
  usedIds.add(id)

  return {
    id,
    kind,
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
/**
 * Guard an observation's target: like `guardedRef`, except a dependency's
 * plain `file` or `directory` target that does not exist returns undefined for
 * the caller to downgrade instead of throwing. Every other shape keeps the
 * throwing guard.
 *
 * `directory` is here because a target's kind is the model's choice of words
 * for the same failed resolution. Measured on
 * `evals/fixtures/supabase/greenfield@whole-repo`: a general scan of the
 * repository root read a compose volume mount and reported
 * `{ kind: 'directory', id: 'docker/volumes/storage' }`, a path the stack
 * creates at runtime. The identical claim written as `kind: 'file'` would have
 * cost a warning; written as `directory` it cost the whole scan, on a batch
 * that had nothing else wrong with it. That asymmetry was an oversight, not a
 * policy: a dependency pointing at something absent is a failed resolution
 * either way.
 */
function guardedTarget(entry: ReplyObservation, guard: PathGuard): Ref | undefined {
  const target = entry.target as { kind: string; id: string }
  if (entry.kind === 'dependency' && isDowngradableTarget(target)) {
    const checked = guard.probe(target.id, 'target')
    return checked.exists ? { kind: target.kind, id: checked.path } : undefined
  }
  return guardedRef(target, guard, 'target')
}

/**
 * A path-carrying target whose absence downgrades rather than throws. A
 * fragment locator is excluded: it scopes a region of a file the instructions
 * defined, so a missing one is a misread of the scheme, not a failed lookup.
 */
function isDowngradableTarget(target: { kind: string; id: string }): boolean {
  if (target.kind === 'directory') return true
  return target.kind === 'file' && !target.id.includes('#')
}

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

interface PathGuard {
  (candidate: string, where: string): string
  /** The same normalization and escape checks, reporting existence instead of throwing on it. */
  probe(candidate: string, where: string): { path: string; exists: boolean }
}

/**
 * The hallucination guard: normalize a model-reported path and verify it is
 * repository-relative, does not escape the repository root, and exists on
 * disk. Anything else throws. A path that fails the guard is a claim about
 * code that is not there, and dropping it silently would let the rest of the
 * reply pass as trustworthy. `probe` runs the same normalization and escape
 * checks but reports existence instead of throwing on it, for the one caller
 * that downgrades a missing dependency target rather than failing the scan.
 */
function pathGuard(repositoryRoot: string): PathGuard {
  const root = path.resolve(repositoryRoot)

  const probe = (candidate: string, where: string): { path: string; exists: boolean } => {
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

    return { path: toPosix(relative), exists: fs.existsSync(absolute) }
  }

  const guard = ((candidate: string, where: string): string => {
    const checked = probe(candidate, where)
    if (!checked.exists) {
      throw new Error(
        `Agent scan reply named an invalid path in ${where}: '${truncate(candidate, 120)}' does not exist in the repository`,
      )
    }
    return checked.path
  }) as PathGuard
  guard.probe = probe
  return guard
}

interface BatchInfo {
  index: number
  total: number
}

/** The batch framing lines, absent entirely for a single-batch scan. */
/**
 * Partition the covered listing into batches of at most `batchFiles`, along
 * the directory tree rather than by position. A directory whose subtree fits
 * in one batch stays whole, sibling directories pack together up to the cap,
 * and only a directory too large for any batch splits. Each call then covers
 * one coherent area: its observations do not straddle modules, and concurrent
 * batches explore disjoint corners of the repository instead of crawling the
 * same folder from two sessions at once. A pure function of the sorted
 * listing, so reruns compose with `cached()`; a listing that fits in one
 * batch stays exactly the sorted listing, byte-identical to the unbatched
 * request.
 */
function partitionListing(files: string[], batchFiles: number): string[][] {
  if (files.length <= batchFiles) return [files]

  interface Node {
    files: string[]
    children: Map<string, Node>
    total: number
  }
  const root: Node = { files: [], children: new Map(), total: files.length }
  for (const file of files) {
    let node = root
    const segments = file.split('/')
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { files: [], children: new Map(), total: 0 }
        node.children.set(segment, child)
      }
      node = child
      node.total += 1
    }
    node.files.push(file)
  }

  // Indivisible units first: whole subtrees that fit, and chunks of the
  // direct files of directories that do not.
  const units: string[][] = []
  const collect = (node: Node): string[] => [
    ...node.files,
    ...[...node.children.keys()].sort().flatMap((name) => collect(node.children.get(name) as Node)),
  ]
  const walk = (node: Node): void => {
    if (node.total <= batchFiles) {
      units.push(collect(node))
      return
    }
    for (let start = 0; start < node.files.length; start += batchFiles) {
      units.push(node.files.slice(start, start + batchFiles))
    }
    for (const name of [...node.children.keys()].sort()) walk(node.children.get(name) as Node)
  }
  walk(root)

  // Then neighboring units coalesce, so a run of small sibling directories
  // costs one call, not one call each.
  const batches: string[][] = []
  let current: string[] = []
  for (const unit of units) {
    if (current.length > 0 && current.length + unit.length > batchFiles) {
      batches.push(current)
      current = []
    }
    current = current.concat(unit)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * What a batch covers, for the narration: the deepest directory common to
 * every file in it, or the whole repository when they share none.
 */
function batchArea(batch: string[]): string {
  let prefix: string[] | undefined
  for (const file of batch) {
    const directory = file.split('/').slice(0, -1)
    if (prefix === undefined) {
      prefix = directory
      continue
    }
    let shared = 0
    while (shared < prefix.length && prefix[shared] === directory[shared]) shared += 1
    prefix = prefix.slice(0, shared)
  }
  return prefix === undefined || prefix.length === 0 ? 'the repository' : prefix.join('/')
}

function batchHeading(batchInfo: BatchInfo | undefined): string {
  return batchInfo === undefined ? '' : `, batch ${batchInfo.index} of ${batchInfo.total}`
}

function batchNote(batchInfo: BatchInfo | undefined): string {
  if (batchInfo === undefined) return ''
  return (
    '\n\nNOTE: this is one batch of a larger scan; parallel batches cover the rest of the ' +
    'repository. Read any file you need to understand the ones listed above, but do not report ' +
    'observations about files outside this listing unless the scan instructions specifically ' +
    'name them.'
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
 * The focused, one-shot context: instructions, code-first excerpts of one
 * batch of the files the focus globs matched, and an inventory of the other
 * files under the scanned roots, assembled as a context pack.
 *
 * Matches beyond `maxFiles` or the pack's byte budget are announced inline,
 * never silently thinned; since the one-shot request has no tools, an
 * unexcerpted file is a file the model genuinely cannot see, and it must
 * know that.
 *
 * The inventory is why `roots` and `focus` are separate options. `focus`
 * chooses whose CONTENTS are embedded; `roots` chooses whose PATHS are known
 * to exist. Without it, a one-shot scan was asked to report paths and given no
 * way to check one, and every instruction of the form "service <name> lives in
 * src/<name>" had to hard-code the exceptions to its own convention or watch a
 * model invent a path and lose the whole reply to the guard. Measured on
 * boutique, where two models independently wrote src/cartservice/Dockerfile for
 * a Dockerfile that lives one directory deeper. Paths only, never contents: an
 * inventory is cheap where an excerpt is not, and existence is all the guard
 * asks about.
 *
 * It goes last on purpose. The excerpts are what the reply is made of, so they
 * take budget first and the inventory is what truncates, announced, if the
 * roots are wide.
 */
function composeFocusedContext(
  repositoryRoot: string,
  instructions: string,
  roots: string[],
  shown: string[],
  alreadyDropped: number,
  excerptChars: number,
  inventory: string[],
  batchInfo?: BatchInfo,
): string {
  const sections = [
    { header: `### Scan instructions\n\n${instructions}`, items: [], what: 'instructions' },
    {
      header:
        `### Focused files under ${roots.join(', ')} (repository-relative${batchHeading(batchInfo)})\n\n` +
        'These excerpts are the only file CONTENTS you have; answer from them.' +
        batchNote(batchInfo),
      items: shown.map(
        (file) => `### ${file}\n${fencedExcerpt(repositoryRoot, file, excerptChars)}`,
      ),
      what: 'focused files',
      alreadyDropped,
    },
  ]
  if (inventory.length > 0) {
    sections.push({
      header:
        `### Other files that exist under ${roots.join(', ')} (paths only, no contents)\n\n` +
        'Use these to check a path before you report it. A path not listed here and not ' +
        'excerpted above may still exist, but you have no evidence of it, so do not report it.',
      items: inventory.map((file) => `- ${file}`),
      what: 'inventory paths',
      alreadyDropped: 0,
    })
  }
  return assemblePack(sections, DEFAULT_PACK_BUDGET_BYTES).text
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
