/**
 * The `architecture-rules` validate provider.
 *
 * Every finding is expressed in terms of model elements, relationships, or
 * ownership — generic code smells are out of scope by design.
 *
 * This provider reads only `Association`'s own fields and the native model
 * from `ValidateContext`. It never reads another provider's `data`, so it works
 * against the contract rather than against one resolve provider's private
 * shape (POC-DESIGN-v4).
 */

import { findingId } from '../ids.ts'
import { isStandardObservationKind } from '../kinds.ts'
import {
  hasRelationship,
  declaredRelationships,
  isSameOrNested,
  ownershipPrefixes,
} from '../model.ts'
import type { Association, Evidence, Finding, Observation, ValidateContext } from '../types.ts'

export const PROVIDER_ID = 'architecture-rules'

/**
 * Evidence per finding is capped: one boundary crossed by a thousand files is
 * one architectural fact, and an uncapped list buries the report.
 */
export const EVIDENCE_LIMIT = 10

export async function architectureRules(context: ValidateContext): Promise<Finding[]> {
  const observations = new Map(context.observations.map((item) => [item.id, item]))
  const declared = declaredRelationships(context.model)
  const collector = new FindingCollector()

  for (const association of context.associations) {
    const observation = observations.get(association.observationId)
    if (observation === undefined) continue

    if (observation.kind === 'file') {
      collector.add(fileRule(association, observation))
    } else if (observation.kind === 'dependency') {
      collector.add(dependencyRule(association, observation, declared))
    } else if (observation.kind === 'unresolved-dependency') {
      collector.add(unresolvedImportRule(association, observation))
    }
  }

  return [
    ...collector.findings(),
    ...coverageRules(context, observations),
    ...modelHygieneRules(context),
    ...vocabularyRules(context),
  ]
}

/**
 * Collects findings, collapsing repeats of the same finding id.
 *
 * Many files can cross the same boundary, but the finding is about the element
 * pair, so they become one finding carrying the crossings as evidence.
 */
class FindingCollector {
  readonly #byId = new Map<string, Finding>()
  readonly #overflow = new Map<string, number>()

  add(finding: Finding | undefined): void {
    if (finding === undefined) return

    const existing = this.#byId.get(finding.id)
    if (existing === undefined) {
      // Copy the evidence array: it is borrowed from the observation, and the
      // rules provider must not hand out or grow something it does not own.
      // The cap applies here too, not only on merge.
      const evidence = finding.evidence ?? []
      this.#byId.set(finding.id, { ...finding, evidence: evidence.slice(0, EVIDENCE_LIMIT) })
      if (evidence.length > EVIDENCE_LIMIT) {
        this.#overflow.set(finding.id, evidence.length - EVIDENCE_LIMIT)
      }
      return
    }

    const incoming = finding.evidence ?? []
    const room = EVIDENCE_LIMIT - (existing.evidence?.length ?? 0)
    if (room > 0) {
      existing.evidence = [...(existing.evidence ?? []), ...incoming.slice(0, room)]
    }
    const dropped = incoming.length - Math.max(0, room)
    if (dropped > 0) this.#overflow.set(finding.id, (this.#overflow.get(finding.id) ?? 0) + dropped)
  }

  findings(): Finding[] {
    for (const [id, dropped] of this.#overflow) {
      const finding = this.#byId.get(id)
      if (finding !== undefined) {
        finding.evidence = [...(finding.evidence ?? []), { detail: `and ${dropped} more` }]
      }
    }
    return [...this.#byId.values()]
  }
}

function fileRule(association: Association, observation: Observation): Finding | undefined {
  const filePath = observation.subject?.id
  if (filePath === undefined) return undefined
  const evidence: Evidence[] = [{ path: filePath }]

  if (association.status === 'unresolved') {
    return {
      id: findingId(PROVIDER_ID, 'unmapped-source', filePath),
      ruleId: 'unmapped-source',
      severity: 'warning',
      description: `${filePath} is not owned by any model element.`,
      subject: { kind: 'file', id: filePath },
      evidence,
      provider: PROVIDER_ID,
    }
  }

  if (association.status === 'ambiguous') {
    const candidates = association.candidates ?? []
    return {
      id: findingId(PROVIDER_ID, 'ambiguous-source', filePath),
      ruleId: 'ambiguous-source',
      severity: 'error',
      description: `${filePath} is claimed by ${candidates.map((ref) => ref.id).join(' and ')}.`,
      subject: { kind: 'file', id: filePath },
      related: candidates,
      evidence,
      provider: PROVIDER_ID,
    }
  }

  return undefined
}

function dependencyRule(
  association: Association,
  observation: Observation,
  declared: ReturnType<typeof declaredRelationships>,
): Finding | undefined {
  if (association.status !== 'resolved') return undefined

  const sourceId = association.source?.id
  const targetId = association.target?.id
  if (sourceId === undefined || targetId === undefined) return undefined

  // Inside one boundary, or between an element and its own ancestor. Not a
  // crossing, and LikeC4 will not let the author declare it anyway.
  if (isSameOrNested(sourceId, targetId)) return undefined

  // Declared, directly or by a relationship between two ancestors.
  if (association.relationship !== undefined) return undefined

  const evidence = observation.evidence

  // The model declares the opposite direction. A stronger signal than a missing
  // relationship: this dependency was modelled backwards.
  const reversed = hasRelationship(declared, targetId, sourceId)
  if (reversed !== undefined) {
    return {
      id: findingId(PROVIDER_ID, 'relationship-direction', `${sourceId}->${targetId}`),
      ruleId: 'relationship-direction',
      severity: 'error',
      description:
        `${sourceId} depends on ${targetId}, but the model declares only ` +
        `${targetId} → ${sourceId}. Declare the dependency that the code actually has.`,
      subject: { kind: 'element', id: sourceId },
      related: [
        { kind: 'element', id: targetId },
        { kind: 'relationship', id: reversed.id },
      ],
      evidence,
      provider: PROVIDER_ID,
    }
  }

  return {
    id: findingId(PROVIDER_ID, 'missing-relationship', `${sourceId}->${targetId}`),
    ruleId: 'missing-relationship',
    severity: 'error',
    description: `${sourceId} depends on ${targetId}, but the model declares no such relationship.`,
    subject: { kind: 'element', id: sourceId },
    related: [{ kind: 'element', id: targetId }],
    evidence,
    provider: PROVIDER_ID,
  }
}

/**
 * A relative import that resolves to nothing.
 *
 * Reported because the alternative is silence: an unresolvable dependency
 * leaves the architecture check with nothing to test, so a renamed file could
 * quietly remove a boundary crossing from the gate.
 */
function unresolvedImportRule(
  association: Association,
  observation: Observation,
): Finding | undefined {
  if (observation.target === undefined) return undefined
  const fromPath = observation.subject?.id ?? association.observationId

  return {
    id: findingId(PROVIDER_ID, 'unresolved-import', `${fromPath}->${observation.target.id}`),
    ruleId: 'unresolved-import',
    severity: 'warning',
    description: `${fromPath} imports ${observation.target.id}, which does not resolve; the dependency cannot be checked.`,
    subject: { kind: 'file', id: fromPath },
    evidence: observation.evidence,
    provider: PROVIDER_ID,
  }
}

/**
 * Ownership metadata that claims nothing.
 *
 * Without this the gate fails open: a typo in `sources` — a stray `./`, a glob
 * the prefix matcher cannot honour, a renamed directory — silently stops
 * matching, every dependency becomes unresolvable, and the run goes green with
 * only warnings.
 */
function coverageRules(
  context: ValidateContext,
  observations: Map<string, Observation>,
): Finding[] {
  const { prefixes, rejected } = ownershipPrefixes(context.model)
  const findings: Finding[] = []

  for (const entry of rejected) {
    findings.push({
      id: findingId(PROVIDER_ID, 'invalid-sources', `${entry.elementId}/${entry.declared}`),
      ruleId: 'invalid-sources',
      severity: 'error',
      description: `${entry.elementId} declares sources '${entry.declared}', which ${entry.reason}.`,
      subject: { kind: 'element', id: entry.elementId },
      provider: PROVIDER_ID,
    })
  }

  const all = [...observations.values()]
  const scanned = all
    .filter((observation) => observation.kind === 'file')
    .map((observation) => observation.subject?.id ?? '')

  // With nothing scanned, every prefix trivially matches nothing. That says
  // something about the scan, not about the model, and whatever broke the scan
  // has already reported itself.
  if (scanned.length === 0) return findings

  // Only judge ownership the scan actually covered. A component may own code
  // outside the scan roots — the same legal state as an element with no
  // `sources` at all — and reporting that would leave the author no fix but to
  // delete truthful metadata.
  const covered = all
    .filter((observation) => observation.kind === 'scan-root')
    .map((observation) => {
      const root = observation.subject?.id ?? ''
      return root === '' || root === '.' ? '' : `${root.replace(/\/+$/, '')}/`
    })

  for (const entry of prefixes) {
    if (scanned.some((filePath) => filePath.startsWith(entry.prefix))) continue
    if (!covered.some((root) => entry.prefix.startsWith(root) || root.startsWith(entry.prefix))) {
      continue
    }
    findings.push({
      id: findingId(PROVIDER_ID, 'unmatched-sources', `${entry.elementId}/${entry.declared}`),
      ruleId: 'unmatched-sources',
      severity: 'error',
      description: `${entry.elementId} declares sources '${entry.declared}', which matches no scanned file.`,
      subject: { kind: 'element', id: entry.elementId },
      provider: PROVIDER_ID,
    })
  }

  return findings
}

/**
 * Relationships the stable identifier scheme cannot tell apart.
 *
 * POC-DESIGN-v4 asked the prototype to confirm whether LikeC4 permits duplicate
 * source/kind/target triples rather than design an ordinal up front. It does,
 * so the collision is surfaced instead of silently dropped.
 */
function modelHygieneRules(context: ValidateContext): Finding[] {
  const { duplicates } = declaredRelationships(context.model)

  return [...duplicates].map(([id, count]) => ({
    id: findingId(PROVIDER_ID, 'duplicate-relationship', id),
    ruleId: 'duplicate-relationship',
    severity: 'info' as const,
    description: `${count} relationships share the identity ${id}; only the first is referenced by findings.`,
    subject: { kind: 'relationship', id },
    provider: PROVIDER_ID,
  }))
}

/**
 * Observations these rules did not understand.
 *
 * Kinds are open on purpose, so an unrecognized kind is not an error. But a
 * scanner that emits `import` where these rules read `dependency` produces no
 * findings and a clean exit — the fail-open this gate exists to prevent, and
 * indistinguishable from a genuinely clean repository. One `info` per kind per
 * provider makes the mismatch visible without punishing providers that
 * legitimately speak to each other in private terms.
 */
function vocabularyRules(context: ValidateContext): Finding[] {
  const counts = new Map<string, { provider: string; kind: string; count: number }>()

  for (const observation of context.observations) {
    if (isStandardObservationKind(observation.kind)) continue
    const key = `${observation.provider}/${observation.kind}`
    const entry = counts.get(key)
    if (entry === undefined) {
      counts.set(key, { provider: observation.provider, kind: observation.kind, count: 1 })
    } else {
      entry.count += 1
    }
  }

  return [...counts.values()].map((entry) => ({
    id: findingId(PROVIDER_ID, 'unknown-observation-kind', `${entry.provider}/${entry.kind}`),
    ruleId: 'unknown-observation-kind',
    severity: 'info' as const,
    description:
      `${entry.provider} emitted ${entry.count} observation(s) of kind '${entry.kind}', ` +
      `which these rules do not interpret.`,
    subject: { kind: 'provider', id: entry.provider },
    provider: PROVIDER_ID,
  }))
}
