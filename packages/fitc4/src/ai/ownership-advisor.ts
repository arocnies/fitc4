/**
 * The `ai-ownership-advisor` validate provider.
 *
 * For every file the resolve phase left unowned, ask the AI which existing
 * element should own it — or whether the model is missing an element. Pure
 * enrichment of the deterministic `unmapped-source` warning: findings default
 * to `info`, the file list and element catalog are prefilled, and one batched
 * call covers every unowned file, so a clean repository costs zero AI calls.
 *
 * Suggestions naming an element that does not exist are reported as exactly
 * that — a hallucinated element must not read like a fix.
 */

import { findingId } from '../ids.ts'
import type {
  Finding,
  JsonObject,
  NamedProvider,
  Severity,
  ValidateContext,
  ValidateProvider,
} from '../types.ts'
import type { AiExec } from './exec.ts'
import { aiTruncated, aiUnavailable, elementCatalog, fileExcerpts } from './findings.ts'

export const PROVIDER_ID = 'ai-ownership-advisor'

export interface OwnershipAdvisorOptions {
  exec: AiExec
  /**
   * The severity of this provider's suggestions — how load-bearing its
   * judgment is. Default 'info' (advisory); 'error' makes it part of the
   * gate, and an unavailable CLI or truncated input then fails the build.
   */
  severity?: Severity
  /** Unowned files reviewed per run; the rest are reported as truncated. */
  maxFiles?: number
  /** Characters of each file shown to the model. */
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

const PROMPT =
  'For each file excerpted in the context, name the id of the existing model element that ' +
  'should own it, or null if no existing element fits. Base the judgment on what the file ' +
  'does, not on its path. Keep each rationale to one sentence.'

export function aiOwnershipAdvisor(
  options: OwnershipAdvisorOptions,
): NamedProvider<ValidateProvider> {
  const severity = options.severity ?? 'info'
  const maxFiles = options.maxFiles ?? 20
  const excerptChars = options.excerptChars ?? 2_000

  const run: ValidateProvider = async (context: ValidateContext): Promise<Finding[]> => {
    const files = unownedFiles(context)
    if (files.length === 0) return []

    const findings: Finding[] = []
    const sent = files.slice(0, maxFiles)
    if (files.length > sent.length) {
      findings.push(aiTruncated(PROVIDER_ID, files.length - sent.length, 'unowned files', severity))
    }
    if (sent.length === 0) return findings

    const reply = await options.exec.run({
      prompt: PROMPT,
      context: `${elementCatalog(context.model)}\n\n${fileExcerpts(context.repositoryRoot, sent, excerptChars)}`,
      schema: REPLY_SCHEMA,
      cwd: context.repositoryRoot,
    })
    if (!reply.ok) {
      findings.push(aiUnavailable(PROVIDER_ID, options.exec.id, reply.error, severity))
      return findings
    }

    const askedFor = new Set(sent)
    const answered = new Set<string>()
    const knownElements = new Set<string>([...context.model.elements()].map((element) => element.id))

    for (const entry of suggestions(reply.value)) {
      // Only files that were actually asked about, once each — the reply is
      // model output, not something the ids may be built from unchecked.
      if (!askedFor.has(entry.path) || answered.has(entry.path)) continue
      answered.add(entry.path)

      findings.push({
        id: findingId(PROVIDER_ID, 'ownership-suggestion', entry.path),
        ruleId: 'ownership-suggestion',
        severity,
        description: describe(entry, knownElements),
        subject: { kind: 'file', id: entry.path },
        related: entry.element !== null && knownElements.has(entry.element)
          ? [{ kind: 'element', id: entry.element }]
          : undefined,
        data: { ai: options.exec.id },
        provider: PROVIDER_ID,
      })
    }

    // Advisory runs shrug off a lazy reply — the deterministic unmapped-source
    // warning still stands for every file. A gating run must not: a file the
    // judge never ruled on is a file that bypassed the gate.
    const unanswered = sent.filter((filePath) => !answered.has(filePath))
    if (unanswered.length > 0 && severity === 'error') {
      findings.push(
        aiUnavailable(
          PROVIDER_ID,
          options.exec.id,
          `the reply omitted ${unanswered.length} of ${sent.length} requested files`,
          severity,
        ),
      )
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
    return `${entry.path}: the AI suggested '${entry.element}', which is not in the model${rationale}`
  }
  return `${entry.path} may belong to ${entry.element}${rationale}`
}
