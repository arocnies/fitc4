/**
 * Drift rules: model-native debt, tagged in the model and counted here.
 *
 * `drift-relationship`, `unused-drift`.
 */

import { findingId } from '../../ids.ts'
import { isAncestorOf, isSameOrNested, type DeclaredRelationship } from '../../model.ts'
import type { Association, Observation } from '../../types.ts'
import { PROVIDER_ID, type Evidence, type Finding, type SeverityOf } from './shared.ts'

/**
 * Declared drift: model-native debt, tagged in the model and counted here.
 *
 * A drift-tagged relationship is an ordinary declared relationship, so the
 * dependencies it covers are already permitted; this ledger only makes them
 * visible. Coverage is tested per drift edge rather than read from
 * `association.relationship`, so a dependency also covered by an untagged
 * relationship still counts as exercising the drift edge. The edge is only
 * `unused-drift` when nothing it covers happens anymore.
 */
export class DriftLedger {
  readonly #edges = new Map<
    string,
    { relationship: DeclaredRelationship; count: number; evidence: Evidence[] }
  >()

  constructor(declared: Iterable<DeclaredRelationship>, driftTag: string) {
    for (const relationship of declared) {
      if (relationship.tags.includes(driftTag)) {
        this.#edges.set(relationship.id, { relationship, count: 0, evidence: [] })
      }
    }
  }

  /** Count a resolved boundary crossing against every drift edge covering it. */
  record(association: Association, observation: Observation): void {
    if (this.#edges.size === 0) return
    if (association.status !== 'resolved') return

    const sourceId = association.source?.id
    const targetId = association.target?.id
    if (sourceId === undefined || targetId === undefined) return
    if (isSameOrNested(sourceId, targetId)) return

    for (const edge of this.#edges.values()) {
      const { relationship } = edge
      const coversSource =
        relationship.sourceId === sourceId || isAncestorOf(relationship.sourceId, sourceId)
      const coversTarget =
        relationship.targetId === targetId || isAncestorOf(relationship.targetId, targetId)
      if (!coversSource || !coversTarget) continue

      edge.count += 1
      // Borrowed evidence; the collector copies and caps it on add.
      edge.evidence.push(...(observation.evidence ?? []))
    }
  }

  /**
   * One finding per drift edge: exercised edges at `info` (the burn-down),
   * unused edges at `warning`. That warning is how the declared set shrinks.
   * The code no longer does this, so the model must stop tolerating it.
   */
  findings(severityOf: SeverityOf): Finding[] {
    return [...this.#edges.values()].map(({ relationship, count, evidence }) => {
      const edge = `${relationship.sourceId} -> ${relationship.targetId}`
      if (count > 0) {
        return {
          id: findingId(PROVIDER_ID, 'drift-relationship', relationship.id),
          ruleId: 'drift-relationship',
          severity: severityOf('drift-relationship', 'info'),
          description:
            `${edge} is declared drift; ${count} ${count === 1 ? 'dependency still rides' : 'dependencies still ride'} it. ` +
            `Remove the code path, then delete the tagged relationship from the model.`,
          subject: { kind: 'relationship', id: relationship.id },
          related: [
            { kind: 'element', id: relationship.sourceId },
            { kind: 'element', id: relationship.targetId },
          ],
          evidence,
          provider: PROVIDER_ID,
        }
      }
      return {
        id: findingId(PROVIDER_ID, 'unused-drift', relationship.id),
        ruleId: 'unused-drift',
        severity: severityOf('unused-drift', 'warning'),
        description:
          `${edge} is declared drift, but no code exercises it anymore. ` +
          `Delete the relationship: the model must not keep tolerating what stopped happening.`,
        subject: { kind: 'relationship', id: relationship.id },
        related: [
          { kind: 'element', id: relationship.sourceId },
          { kind: 'element', id: relationship.targetId },
        ],
        provider: PROVIDER_ID,
      }
    })
  }
}
