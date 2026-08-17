/**
 * The `ai-semantic-review` validate provider.
 *
 * Judges whether each element's implementation still matches its declared
 * description — the drift relationships cannot express: the "read-only
 * reporting layer" that started writing, the "adapter" that grew business
 * logic. Only elements that have both a description and owned files are
 * reviewed; there is nothing to judge against otherwise.
 *
 * One call per element rather than one batch, so a response cache keyed on
 * inputs re-reviews only the elements whose files actually changed. Calls run
 * sequentially, and the first exec failure stops the run — one `ai-unavailable`
 * finding, not one per element against a dead CLI.
 */

import { findingId } from '../ids.ts'
import { elementText } from './findings.ts'
import type {
  Evidence,
  Finding,
  JsonObject,
  NamedProvider,
  Severity,
  ValidateContext,
  ValidateProvider,
} from '../types.ts'
import type { AiExec } from './exec.ts'
import { aiTruncated, aiUnavailable, clampSeverity, fileExcerpts } from './findings.ts'

export const PROVIDER_ID = 'ai-semantic-review'

export interface SemanticReviewOptions {
  exec: AiExec
  /** Ceiling on every finding this provider emits. Default: 'warning'. */
  maxSeverity?: Severity
  /** Elements reviewed per run; the rest are reported as truncated. */
  maxElements?: number
  /** Owned files shown per element, in path order. */
  maxFilesPerElement?: number
  /** Characters of each file shown to the model. */
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

export function aiSemanticReview(options: SemanticReviewOptions): NamedProvider<ValidateProvider> {
  const maxSeverity = options.maxSeverity ?? 'warning'
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
        aiTruncated(PROVIDER_ID, reviewable.length - reviewed.length, 'described elements', maxSeverity),
      )
    }

    for (const element of reviewed) {
      const files = element.files.slice(0, maxFilesPerElement)
      const reply = await options.exec.run({
        prompt:
          `Element ${element.id} declares: "${element.description}". Judge whether the excerpted ` +
          'implementation matches that description. Report only behavior the description rules out ' +
          'or clearly promises but the code lacks — not style, quality, or completeness. ' +
          'Set matches=false only for a concrete mismatch, each stated in one sentence in issues.',
        context: fileExcerpts(context.repositoryRoot, files, excerptChars),
        schema: REPLY_SCHEMA,
        cwd: context.repositoryRoot,
      })

      if (!reply.ok) {
        findings.push(aiUnavailable(PROVIDER_ID, options.exec.id, reply.error, maxSeverity))
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
        severity: clampSeverity('warning', maxSeverity),
        description:
          `${element.id} may no longer match its description` +
          (issues.length > 0 ? `: ${issues[0]}` : '.'),
        subject: { kind: 'element', id: element.id },
        evidence: issues.map((issue): Evidence => ({ detail: issue })),
        data: { ai: options.exec.id },
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
