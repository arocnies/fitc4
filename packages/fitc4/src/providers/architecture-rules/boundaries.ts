/**
 * Boundary rules: dependencies the model does not permit.
 *
 * `missing-relationship`, `relationship-direction`, `unresolved-import`, and
 * the type-only policy that adjusts the first two.
 */

import { findingId } from '../../ids.ts'
import { hasRelationship, isSameOrNested, type declaredRelationships } from '../../model.ts'
import type { Association, Observation } from '../../types.ts'
import { PROVIDER_ID, type Finding, type SeverityOf, type TypeOnlyImportsPolicy } from './shared.ts'

export function dependencyRule(
  association: Association,
  observation: Observation,
  declared: ReturnType<typeof declaredRelationships>,
  severityOf: SeverityOf,
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

  // The model declares the opposite direction. A stronger signal than a
  // missing relationship: this dependency was modelled backwards.
  //
  // The remedy names the code fix only. The model is the contract; whether
  // the contract itself should change is a design decision that belongs to
  // the norms this package ships, not to a message an agent acts on directly.
  const reversed = hasRelationship(declared, targetId, sourceId)
  if (reversed !== undefined) {
    return {
      id: findingId(PROVIDER_ID, 'relationship-direction', `${sourceId}->${targetId}`),
      ruleId: 'relationship-direction',
      severity: severityOf('relationship-direction', 'error'),
      description:
        `${sourceId} depends on ${targetId}, but the model declares only ` +
        `${targetId} -> ${sourceId}. Reroute or remove the import so the dependency flows ` +
        `the way the model declares.`,
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
    severity: severityOf('missing-relationship', 'error'),
    description: `${sourceId} depends on ${targetId}, but the model declares no such relationship.`,
    subject: { kind: 'element', id: sourceId },
    related: [{ kind: 'element', id: targetId }],
    evidence,
    provider: PROVIDER_ID,
  }
}

/**
 * A dependency the resolver could not map onto the model.
 *
 * The scan reported an edge in some vocabulary — a path no element claims, a
 * name no element bears, or a name two elements share — and resolution came
 * back empty or ambiguous. Reported for the same reason as `unresolved-import`:
 * the alternative is silence, and a dependency that maps to nothing is a
 * boundary crossing the gate never judged. Two entire agent-scan replies were
 * once dropped this way without a single finding, which is the fail-open
 * outcome nothing downstream can flag.
 *
 * Scoped to edges that speak names: an endpoint whose kind is not a path
 * (`file`, `directory`) or a package (`module`). Path refs have their own
 * rule family — `unmapped-source` names the unowned file, `unresolved-import`
 * the broken specifier — and repeating those per edge would bury a brownfield
 * report. A named endpoint that maps to nothing has no other rule to speak
 * for it, and external packages are exempt because a `module` target no
 * element claims is the normal state of almost every import, not a gap in
 * the model.
 */
export function unmappedReferenceRule(
  association: Association,
  observation: Observation,
  severityOf: SeverityOf,
): Finding | undefined {
  if (association.status !== 'unresolved' && association.status !== 'ambiguous') return undefined
  if (observation.target === undefined || observation.target.kind === 'module') return undefined

  const speaksNames = [observation.subject, observation.target].some(
    (ref) =>
      ref !== undefined && ref.kind !== 'file' && ref.kind !== 'directory' && ref.kind !== 'module',
  )
  if (!speaksNames) return undefined

  const fromId = observation.subject?.id ?? association.observationId
  const toId = observation.target.id
  const candidates = association.candidates ?? []
  const why =
    association.status === 'ambiguous'
      ? `an endpoint is claimed by ${candidates.map((ref) => ref.id).join(' and ')}`
      : 'the edge does not map onto two model elements'

  return {
    id: findingId(PROVIDER_ID, 'unmapped-reference', `${fromId}->${toId}`),
    ruleId: 'unmapped-reference',
    severity: severityOf('unmapped-reference', 'warning'),
    description: `${fromId} depends on ${toId}, but ${why}, so the dependency cannot be checked.`,
    subject: observation.subject ?? { kind: 'file', id: fromId },
    ...(candidates.length > 0 ? { related: candidates } : {}),
    evidence: observation.evidence,
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
export function unresolvedImportRule(
  association: Association,
  observation: Observation,
  severityOf: SeverityOf,
): Finding | undefined {
  if (observation.target === undefined) return undefined
  const fromPath = observation.subject?.id ?? association.observationId

  return {
    id: findingId(PROVIDER_ID, 'unresolved-import', `${fromPath}->${observation.target.id}`),
    ruleId: 'unresolved-import',
    severity: severityOf('unresolved-import', 'warning'),
    description: `${fromPath} imports ${observation.target.id}, which does not resolve; the dependency cannot be checked.`,
    subject: { kind: 'file', id: fromPath },
    evidence: observation.evidence,
    provider: PROVIDER_ID,
  }
}

/** Whether a dependency observation records a compile-time-only import. */
export function isTypeOnlyDependency(observation: Observation): boolean {
  return observation.data?.['typeOnly'] === true
}

/**
 * Apply the type-only policy to boundary findings.
 *
 * Runs after collection because an edge aggregates possibly many dependencies
 * and is type-only only when every one of them is. Whatever the policy, a
 * surviving boundary finding on a purely type-only edge says `(type-only)`,
 * so even default enforcement is honest about what crossed. Only ids present
 * in `edgeIsTypeOnly` are boundary findings from dependencies; everything
 * else passes through untouched.
 */
export function applyTypeOnlyPolicy(
  findings: Finding[],
  edgeIsTypeOnly: Map<string, boolean>,
  policy: TypeOnlyImportsPolicy,
): Finding[] {
  const result: Finding[] = []

  for (const finding of findings) {
    if (edgeIsTypeOnly.get(finding.id) !== true) {
      result.push(finding)
      continue
    }
    if (policy === 'ignore') continue
    result.push({
      ...finding,
      ...(policy === 'info' ? { severity: 'info' as const } : {}),
      description: `${finding.description} (type-only)`,
    })
  }

  return result
}
