/**
 * What every architecture-rules family shares: the provider identity, the
 * rule vocabulary, the severity plumbing, and the finding collector.
 *
 * A separate module rather than the provider entry point so the family files
 * (`boundaries.ts`, `ownership.ts`, ...) and the entry point both import from
 * here without a cycle.
 */

import type { Evidence, Finding, Severity } from '../../types.ts'

export const PROVIDER_ID = 'architecture-rules'

/**
 * Evidence per finding is capped: one boundary crossed by a thousand files is
 * one architectural fact, and an uncapped list buries the report.
 */
export const EVIDENCE_LIMIT = 10

/**
 * Every rule these checks can emit, in the standard-severity order of the docs.
 *
 * A runtime array rather than a bare type union, because the `severity`
 * option is validated against it: a key naming a rule that does not exist
 * must be an error, and a type union cannot say so at runtime. The type is
 * derived from the array so the two cannot drift.
 */
export const ARCHITECTURE_RULE_IDS = [
  'missing-relationship',
  'relationship-direction',
  'ambiguous-source',
  'invalid-sources',
  'unmatched-sources',
  'invalid-packages',
  'ambiguous-package',
  'unmatched-packages',
  'unmapped-source',
  'unmapped-reference',
  'unresolved-import',
  'drift-relationship',
  'unused-drift',
  'unobserved-elements',
  'duplicate-relationship',
  'unknown-observation-kind',
] as const

export type ArchitectureRuleId = (typeof ARCHITECTURE_RULE_IDS)[number]

/** The default tag marking a relationship as tolerated drift. */
export const DEFAULT_DRIFT_TAG = 'drift'

/**
 * What a boundary crossing made only of type-only imports means.
 *
 * The scanner marks a dependency `typeOnly` when the import is erased at
 * compile time. An edge between two elements aggregates possibly many
 * dependencies, and the edge is type-only only when every one of them is:
 * a single value import makes it runtime coupling.
 *
 * - `'enforce'` (the default) treats a type-only edge like any other, but the
 *   boundary finding says `(type-only)` so the report is honest about what
 *   crossed.
 * - `'info'` downgrades boundary findings (`missing-relationship`,
 *   `relationship-direction`) on purely type-only edges to `info` severity.
 * - `'ignore'` drops those findings entirely. Ignored means not counted
 *   anywhere: under `'ignore'` a type-only dependency also stops counting as
 *   exercising a drift-tagged relationship, so a drift edge kept alive only
 *   by type imports reports as `unused-drift`. Under `'enforce'` and `'info'`
 *   it still counts.
 */
export type TypeOnlyImportsPolicy = 'enforce' | 'info' | 'ignore'

export interface ArchitectureRulesOptions {
  /**
   * Per-rule severity overrides.
   *
   * The standard severities assume adoption: new unowned code is a `warning`
   * nudge, not a broken build. A team done adopting promotes it with
   * `{ 'unmapped-source': 'error' }`, and unowned code then fails the gate
   * instead of slipping past it, since dependencies from unowned files are
   * never boundary-checked. Softening works the same way during a migration.
   *
   * Declared drift is tuned the same way: `{ 'drift-relationship': 'error' }`
   * forbids all tolerated drift, and `{ 'unused-drift': 'error' }` means a
   * drift edge the code no longer exercises fails the gate until it is deleted
   * from the model, so declared drift can only shrink.
   */
  severity?: Partial<Record<ArchitectureRuleId, Severity>>
  /**
   * The relationship tag that marks model-native debt.
   *
   * A relationship carrying this tag is permitted but counted: dependencies it
   * covers stay legal while the `drift-relationship` finding keeps the edge
   * visible in every report. The tag must be declared in the LikeC4
   * specification (`tag drift`), since LikeC4 itself rejects unknown tags.
   */
  driftTag?: string
  /**
   * How to judge boundary crossings made only of type-only imports.
   * See `TypeOnlyImportsPolicy`. Defaults to `'enforce'`.
   */
  typeOnlyImports?: TypeOnlyImportsPolicy
}

/** How load-bearing each rule is: the configured override, or the standard severity. */
export type SeverityOf = (rule: ArchitectureRuleId, standard: Severity) => Severity

/**
 * Collects findings, collapsing repeats of the same finding id.
 *
 * Many files can cross the same boundary, but the finding is about the element
 * pair, so they become one finding carrying the crossings as evidence.
 */
export class FindingCollector {
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

/** Type re-export convenience for the family files. */
export type { Evidence, Finding, Severity }
