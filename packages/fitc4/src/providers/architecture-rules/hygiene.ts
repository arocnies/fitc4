/**
 * Hygiene rules: states that are legal but must be chosen, not accidental.
 *
 * `unobserved-elements`, `duplicate-relationship`,
 * `unknown-observation-kind`.
 */

import { findingId } from '../../ids.ts'
import { isStandardObservationKind } from '../../kinds.ts'
import {
  normalizeSources,
  PACKAGES_KEY,
  SOURCES_KEY,
  type declaredRelationships,
} from '../../model.ts'
import type { ValidateContext } from '../../types.ts'
import { PROVIDER_ID, type Finding, type SeverityOf } from './shared.ts'

/** How many unobserved element ids the finding lists before collapsing to a count. */
const UNOBSERVED_LIST_LIMIT = 10

/**
 * Leaf elements nothing observes.
 *
 * An element with neither `sources` nor `packages` is legal, as a person or an
 * external system or a pure-thought element, but silently unenforced, which is
 * indistinguishable from a typo'd claim key. One `info` finding lists them so
 * the state is chosen, not accidental. A parent whose children carry the
 * claims is structural, not unobserved, so only leaves count.
 */
export function unobservedElementsRule(
  context: ValidateContext,
  severityOf: SeverityOf,
): Finding[] {
  const unobserved: string[] = []

  for (const element of context.model.elements()) {
    if (element.children().size > 0) continue
    if (normalizeSources(element.metadata[SOURCES_KEY]).length > 0) continue
    if (normalizeSources(element.metadata[PACKAGES_KEY]).length > 0) continue
    unobserved.push(element.id)
  }

  if (unobserved.length === 0) return []

  unobserved.sort()
  const listed = unobserved.slice(0, UNOBSERVED_LIST_LIMIT).join(', ')
  const overflow =
    unobserved.length > UNOBSERVED_LIST_LIMIT
      ? ` +${unobserved.length - UNOBSERVED_LIST_LIMIT} more`
      : ''

  return [
    {
      id: findingId(PROVIDER_ID, 'unobserved-elements', 'model'),
      ruleId: 'unobserved-elements',
      severity: severityOf('unobserved-elements', 'info'),
      description:
        `${unobserved.length} element(s) declare neither 'sources' nor 'packages', ` +
        `so nothing checks them: ${listed}${overflow}.`,
      related: unobserved.slice(0, UNOBSERVED_LIST_LIMIT).map((id) => ({ kind: 'element', id })),
      provider: PROVIDER_ID,
    },
  ]
}

/**
 * Relationships the stable identifier scheme cannot tell apart.
 *
 * LikeC4 permits duplicate source/kind/target triples, which all collapse
 * onto one stable id, so this rule reports the collision instead of dropping
 * it silently. Only the first duplicate is ever referenced by findings.
 */
export function modelHygieneRules(
  declared: ReturnType<typeof declaredRelationships>,
  severityOf: SeverityOf,
): Finding[] {
  const { duplicates } = declared

  return [...duplicates].map(([id, count]) => ({
    id: findingId(PROVIDER_ID, 'duplicate-relationship', id),
    ruleId: 'duplicate-relationship',
    severity: severityOf('duplicate-relationship', 'info'),
    description: `${count} relationships share the identity ${id}; only the first is referenced by findings.`,
    subject: { kind: 'relationship' as const, id },
    provider: PROVIDER_ID,
  }))
}

/**
 * Observations these rules did not understand.
 *
 * Kinds are open on purpose, so an unrecognized kind is not an error. But a
 * scanner that emits `import` where these rules read `dependency` produces no
 * findings and a clean exit. That is the fail-open this gate exists to
 * prevent, and it is indistinguishable from a genuinely clean repository.
 * One `info` per kind per provider makes the mismatch visible without
 * punishing providers that legitimately speak to each other in private terms.
 */
export function vocabularyRules(context: ValidateContext, severityOf: SeverityOf): Finding[] {
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
    severity: severityOf('unknown-observation-kind', 'info'),
    description:
      `${entry.provider} emitted ${entry.count} observation(s) of kind '${entry.kind}', ` +
      `which these rules do not interpret.`,
    subject: { kind: 'provider' as const, id: entry.provider },
    provider: PROVIDER_ID,
  }))
}
