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
