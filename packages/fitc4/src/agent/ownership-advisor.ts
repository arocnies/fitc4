/**
 * The `agent-ownership-advisor` validate provider.
 *
 * For every file the resolve phase left unowned, ask the agent which existing
 * element should own it, or whether the model is missing an element. Pure
 * enrichment of the deterministic `unmapped-source` warning: findings default
 * to `info`, the context is prefilled, and one batched call covers every
 * unowned file, so a clean repository costs zero agent calls.
 *
 * The context is a pack: the element catalog, then per file its import
 * NEIGHBORHOOD, meaning what it imports and what imports it with each neighbor
 * annotated by its owning element, ahead of a short code-first excerpt. The
 * neighborhood is the fact ownership actually turns on (a file imported only
 * by `core` almost certainly belongs near `core`), and the pipeline already
 * knows it, so the excerpt can stay small.
 *
 * Suggestions naming an element that does not exist are reported as exactly
 * that. A hallucinated element must not read like a fix.
 */

import { findingId } from '../ids.ts'
import { count } from '../report.ts'
import type {
  Finding,
  JsonObject,
  NamedProvider,
  Severity,
  ValidateContext,
  ValidateProvider,
} from '../types.ts'
import {
  assemblePack,
  buildGraph,
  DEFAULT_PACK_BUDGET_BYTES,
  fencedExcerpt,
  fileNeighborhood,
} from './context-pack.ts'
import type { AgentExec } from './exec.ts'
import { agentTruncated, agentUnavailable, elementCatalog } from './findings.ts'

export const PROVIDER_ID = 'agent-ownership-advisor'

export interface OwnershipAdvisorOptions {
  exec: AgentExec
  /**
   * The severity of this provider's suggestions, which is to say how
   * load-bearing its judgment is. Default 'info' (advisory); 'error' makes it
   * part of the gate, and an unavailable CLI or truncated input then fails the
   * build.
   */
  severity?: Severity
  /**
   * Unowned files sent per call. Files beyond one call's worth are not
   * dropped: they run as further batches through the worker pool, each
   * announced by its position. Zero is the opt-out: no calls, every unowned
   * file attested as truncated.
   */
  maxFiles?: number
  /**
   * Characters of each file shown to the model, code-first. Small by
   * default, because the neighborhood lines carry the ownership signal and the
   * excerpt only needs to show what kind of code this is.
   */
  excerptChars?: number
}

const REPLY_SCHEMA: JsonObject = {
  type: 'object',
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'element', 'rationale'],
        properties: {
          path: { type: 'string' },
          element: { type: ['string', 'null'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

/**
 * Batches run through the same worker-pool shape as agentScan's: disjoint
 * file chunks, findings collected in per-batch slots merged in batch order,
 * so a pooled run reports byte-identically to a sequential one. Advisory
 * stays advisory: the first exec failure stops the pool from scheduling more
 * and reports one agent-unavailable, not one per in-flight call.
 */
const ADVISOR_CONCURRENCY = 4

const PROMPT =
  'For each file in the context, name the id of the existing model element that should own it, ' +
  'or null if no existing element fits. Base the judgment on what the file does and on its ' +
  'neighborhood — which elements own the files it imports and the files that import it — not on ' +
  'its path. Keep each rationale to one sentence.'

export function agentOwnershipAdvisor(
  options: OwnershipAdvisorOptions,
): NamedProvider<ValidateProvider> {
  const severity = options.severity ?? 'info'
  const maxFiles = options.maxFiles ?? 20
  const excerptChars = options.excerptChars ?? 1_000

  const run: ValidateProvider = async (context: ValidateContext): Promise<Finding[]> => {
    const files = unownedFiles(context)
    if (files.length === 0) return []

    // The documented opt-out: a zero budget makes no calls, and what was not
    // judged is attested rather than silently skipped.
    if (maxFiles <= 0) {
      return [agentTruncated(PROVIDER_ID, files.length, 'unowned files', severity)]
    }

    const batches: string[][] = []
    for (let start = 0; start < files.length; start += maxFiles) {
      batches.push(files.slice(start, start + maxFiles))
    }

    const graph = buildGraph(context.model, context.observations, context.associations)
    const knownElements = new Set<string>([...context.model.elements()].map((element) => element.id))
    const perBatch: Finding[][] = new Array<Finding[]>(batches.length)
    let unavailable = false

    const runBatch = async (index: number): Promise<void> => {
      const slot: Finding[] = []
      perBatch[index] = slot
      const sent = batches[index] as string[]

      const pack = assemblePack(
        [
          { header: elementCatalog(context.model), items: [], what: 'element catalog' },
          ...sent.map((file) => ({
            header: `### ${file} (unowned)`,
            items: [
              `Neighborhood:\n${fileNeighborhood(graph, file)}`,
              `Excerpt (code-first):\n${fencedExcerpt(context.repositoryRoot, file, excerptChars)}`,
            ],
            what: `context blocks for ${file}`,
          })),
        ],
        DEFAULT_PACK_BUDGET_BYTES,
      )
      // The byte budget's drops are attested: a judge that never saw part of
      // its evidence must not read as one that did.
      for (const drop of pack.dropped) {
        slot.push(agentTruncated(PROVIDER_ID, drop.count, drop.what, severity))
      }

      // Announce before the call: it is the slow part, and the count says why.
      context.progress?.(
        `asking ${options.exec.id} to suggest owners for ${count(sent.length, 'unowned file')}` +
          (batches.length > 1 ? ` (batch ${index + 1} of ${batches.length})` : ''),
      )

      const reply = await options.exec.run({
        prompt: PROMPT,
        context: pack.text,
        schema: REPLY_SCHEMA,
        cwd: context.repositoryRoot,
      })
      if (!reply.ok) {
        // One agent-unavailable for the run, not one per in-flight call: the
        // first failure stops the pool from scheduling more, and a second
        // in-flight failure is the same dead CLI already reported.
        if (!unavailable) {
          unavailable = true
          slot.push(agentUnavailable(PROVIDER_ID, options.exec.id, reply.error, severity))
        }
        return
      }

      const askedFor = new Set(sent)
      const answered = new Set<string>()

      for (const entry of suggestions(reply.value)) {
        // Only files that were actually asked about, once each. The reply is
        // model output, not something the ids may be built from unchecked.
        if (!askedFor.has(entry.path) || answered.has(entry.path)) continue
        answered.add(entry.path)

        slot.push({
          id: findingId(PROVIDER_ID, 'ownership-suggestion', entry.path),
          ruleId: 'ownership-suggestion',
          severity,
          description: describe(entry, knownElements),
          subject: { kind: 'file', id: entry.path },
          related: entry.element !== null && knownElements.has(entry.element)
            ? [{ kind: 'element', id: entry.element }]
            : undefined,
          data: { agent: options.exec.id },
          provider: PROVIDER_ID,
        })
      }

      // Advisory runs shrug off a lazy reply, since the deterministic
      // unmapped-source warning still stands for every file. A gating run must
      // not: a file the judge never ruled on is a file that bypassed the gate.
      const unanswered = sent.filter((filePath) => !answered.has(filePath))
      if (unanswered.length > 0 && severity === 'error') {
        slot.push(
          agentUnavailable(
            PROVIDER_ID,
            options.exec.id,
            `the reply omitted ${unanswered.length} of ${sent.length} requested files`,
            severity,
          ),
        )
      }
    }

    let nextIndex = 0
    await Promise.all(
      Array.from({ length: Math.min(ADVISOR_CONCURRENCY, batches.length) }, async () => {
        while (!unavailable) {
          const index = nextIndex
          nextIndex += 1
          if (index >= batches.length) return
          await runBatch(index)
        }
      }),
    )

    const findings: Finding[] = []
    for (const slot of perBatch) {
      if (slot !== undefined) findings.push(...slot)
    }
    return findings
  }

  return { id: PROVIDER_ID, run }
}

/** Files whose file observation the resolve phase left `unresolved`. */
function unownedFiles(context: ValidateContext): string[] {
  const observations = new Map(context.observations.map((entry) => [entry.id, entry]))
  const paths = new Set<string>()

  for (const association of context.associations) {
    if (association.status !== 'unresolved') continue
    const observation = observations.get(association.observationId)
    if (observation?.kind !== 'file') continue
    const filePath = observation.subject?.id
    if (filePath !== undefined) paths.add(filePath)
  }

  return [...paths].sort()
}

interface Suggestion {
  path: string
  element: string | null
  rationale: string
}

/** The reply's file entries, shape-checked; anything malformed is dropped. */
function suggestions(value: unknown): Suggestion[] {
  const record = value as { files?: unknown }
  if (!Array.isArray(record?.files)) return []

  const result: Suggestion[] = []
  for (const entry of record.files) {
    const candidate = entry as { path?: unknown; element?: unknown; rationale?: unknown }
    if (typeof candidate?.path !== 'string') continue
    if (typeof candidate.element !== 'string' && candidate.element !== null) continue
    result.push({
      path: candidate.path,
      element: candidate.element,
      rationale: typeof candidate.rationale === 'string' ? candidate.rationale : '',
    })
  }
  return result
}

function describe(entry: Suggestion, knownElements: Set<string>): string {
  const rationale = entry.rationale === '' ? '' : `: ${entry.rationale}`
  if (entry.element === null) {
    return `${entry.path} fits no existing element; the model may be missing one${rationale}`
  }
  if (!knownElements.has(entry.element)) {
    return `${entry.path}: the agent suggested '${entry.element}', which is not in the model${rationale}`
  }
  return `${entry.path} may belong to ${entry.element}${rationale}`
}
