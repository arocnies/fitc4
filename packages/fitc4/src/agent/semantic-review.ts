/**
 * The `agent-semantic-review` validate provider.
 *
 * Judges whether each element's implementation still matches its declared
 * description — the drift relationships cannot express: the "read-only
 * reporting layer" that started writing, the "adapter" that grew business
 * logic. Only elements that have both a description and owned files are
 * reviewed; there is nothing to judge against otherwise.
 *
 * One call per element rather than one batch, so a response cache keyed on
 * inputs re-reviews only the elements whose files actually changed. Calls run
 * sequentially, and the first exec failure stops the run — one `agent-unavailable`
 * finding, not one per element against a dead CLI.
 *
 * Each element's context is a context pack: the element's facts first —
 * description, declared relationships, observed resolved edges, and the
 * COMPLETE owned-file list, so the model knows what exists even when a file
 * is not excerpted — then code-first excerpts of the owned files. Files
 * beyond `maxFilesPerElement` are announced in the context AND attested as an
 * `agent-truncated` finding (escalating under a gating severity): a judge
 * that saw half an element must never read as one that saw all of it.
 */

import { findingId } from '../ids.ts'
import type {
  Evidence,
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
  elementPack,
  fencedExcerpt,
} from './context-pack.ts'
import type { AgentExec } from './exec.ts'
import { agentTruncated, agentUnavailable, elementText } from './findings.ts'

export const PROVIDER_ID = 'agent-semantic-review'

export interface SemanticReviewOptions {
  exec: AgentExec
  /**
   * The severity of a drift finding — how load-bearing this review is.
   * Default 'warning' (advisory); 'error' makes it part of the gate, and an
   * unavailable CLI or truncated input then fails the build.
   */
  severity?: Severity
  /** Elements reviewed per run; the rest are reported as truncated. */
  maxElements?: number
  /**
   * Owned files excerpted per element, in path order. Files beyond the cap
   * stay listed in the element facts, are announced in the context, and are
   * attested as an `agent-truncated` finding.
   */
  maxFilesPerElement?: number
  /** Characters of each file shown to the model, code-first. */
  excerptChars?: number
}

const REPLY_SCHEMA: JsonObject = {
  type: 'object',
  required: ['matches', 'issues'],
  properties: {
    matches: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const ISSUE_LIMIT = 5

export function agentSemanticReview(options: SemanticReviewOptions): NamedProvider<ValidateProvider> {
  const severity = options.severity ?? 'warning'
  const maxElements = options.maxElements ?? 10
  const maxFilesPerElement = options.maxFilesPerElement ?? 8
  const excerptChars = options.excerptChars ?? 1_500

  const run: ValidateProvider = async (context: ValidateContext): Promise<Finding[]> => {
    const reviewable = describedElements(context)
    if (reviewable.length === 0) return []

    const findings: Finding[] = []
    const reviewed = reviewable.slice(0, maxElements)
    if (reviewable.length > reviewed.length) {
      findings.push(
        agentTruncated(PROVIDER_ID, reviewable.length - reviewed.length, 'described elements', severity),
      )
    }

    const graph = buildGraph(context.model, context.observations, context.associations)

    for (const element of reviewed) {
      const excerpted = element.files.slice(0, maxFilesPerElement)
      const pack = assemblePack(
        [
          { header: elementPack(graph, element.id, { excerpted }), items: [], what: 'element facts' },
          {
            header: '### Owned-file excerpts (code-first)',
            items: excerpted.map(
              (file) => `### ${file}\n${fencedExcerpt(context.repositoryRoot, file, excerptChars)}`,
            ),
            what: `owned files of ${element.id}`,
            alreadyDropped: element.files.length - excerpted.length,
          },
        ],
        DEFAULT_PACK_BUDGET_BYTES,
      )
      // Attested truncation: whatever the pack could not show — the file cap
      // or the byte budget — is a finding, not a silent thinning of the
      // judge's evidence. Escalates to error when this provider gates.
      for (const drop of pack.dropped) {
        findings.push(agentTruncated(PROVIDER_ID, drop.count, drop.what, severity))
      }

      const reply = await options.exec.run({
        prompt:
          `Element ${element.id} declares: "${element.description}". Judge whether the element ` +
          'facts and excerpted implementation in the context match that description. Report only ' +
          'behavior the description rules out or clearly promises but the code lacks — not style, ' +
          'quality, or completeness. ' +
          'Set matches=false only for a concrete mismatch, each stated in one sentence in issues.',
        context: pack.text,
        schema: REPLY_SCHEMA,
        cwd: context.repositoryRoot,
      })

      if (!reply.ok) {
        findings.push(agentUnavailable(PROVIDER_ID, options.exec.id, reply.error, severity))
        break
      }

      const verdict = reply.value as { matches?: unknown; issues?: unknown }
      if (verdict?.matches !== false) continue

      const issues = (Array.isArray(verdict.issues) ? verdict.issues : [])
        .filter((issue): issue is string => typeof issue === 'string')
        .slice(0, ISSUE_LIMIT)

      findings.push({
        id: findingId(PROVIDER_ID, 'description-drift', element.id),
        ruleId: 'description-drift',
        severity,
        description:
          `${element.id} may no longer match its description` +
          (issues.length > 0 ? `: ${issues[0]}` : '.'),
        subject: { kind: 'element', id: element.id },
        evidence: issues.map((issue): Evidence => ({ detail: issue })),
        data: { agent: options.exec.id },
        provider: PROVIDER_ID,
      })
    }

    return findings
  }

  return { id: PROVIDER_ID, run }
}

interface ReviewableElement {
  id: string
  description: string
  files: string[]
}

/** Elements with a description and resolved file ownership, in id order. */
function describedElements(context: ValidateContext): ReviewableElement[] {
  const observations = new Map(context.observations.map((entry) => [entry.id, entry]))
  const owned = new Map<string, Set<string>>()

  for (const association of context.associations) {
    if (association.status !== 'resolved') continue
    const observation = observations.get(association.observationId)
    if (observation?.kind !== 'file') continue
    const filePath = observation.subject?.id
    const elementId = association.source?.id
    if (filePath === undefined || elementId === undefined) continue
    if (!owned.has(elementId)) owned.set(elementId, new Set())
    owned.get(elementId)?.add(filePath)
  }

  const result: ReviewableElement[] = []
  for (const element of context.model.elements()) {
    const description = elementText(element.description)
    const files = owned.get(element.id)
    if (description === undefined || description === '' || files === undefined) continue
    result.push({ id: element.id, description, files: [...files].sort() })
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
