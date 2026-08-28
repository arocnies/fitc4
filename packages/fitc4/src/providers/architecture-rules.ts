/**
 * The `architecture-rules` validate provider.
 *
 * Every finding is expressed in terms of model elements, relationships, or
 * ownership. Generic code smells are out of scope by design.
 *
 * This provider reads only `Association`'s own fields and the native model
 * from `ValidateContext`. It never reads a resolve provider's `data`, so it
 * works against the contract rather than against one resolve provider's
 * private shape. Any resolve provider that fills the contract feeds these
 * rules. The one observation data field it reads is `typeOnly` on
 * `dependency` observations, which is part of the shared vocabulary
 * (see `kinds.ts`), not any provider's private shape.
 *
 * The rules live in `architecture-rules/` by family: `boundaries` (undeclared
 * dependencies), `ownership` (files and `sources` claims), `packages`
 * (external package claims), `drift` (tolerated debt), `hygiene` (legal but
 * must-be-chosen states). Extending the gate does not mean extending this
 * provider: compose another one into the config's `validate` array.
 */

import { closestName } from '../errors.ts'
import { declaredRelationships } from '../model.ts'
import {
  isSeverity,
  SEVERITIES,
  type Finding,
  type NamedProvider,
  type ValidateContext,
  type ValidateProvider,
} from '../types.ts'
import {
  applyTypeOnlyPolicy,
  dependencyRule,
  isTypeOnlyDependency,
  unmappedReferenceRule,
  unresolvedImportRule,
} from './architecture-rules/boundaries.ts'
import { circularDependencyRules, type DeclaredEdge } from './architecture-rules/cycles.ts'
import { DriftLedger } from './architecture-rules/drift.ts'
import {
  modelHygieneRules,
  unobservedElementsRule,
  vocabularyRules,
} from './architecture-rules/hygiene.ts'
import { coverageRules, fileRule } from './architecture-rules/ownership.ts'
import { packageRules } from './architecture-rules/packages.ts'
import {
  ARCHITECTURE_RULE_IDS,
  DEFAULT_DRIFT_TAG,
  FindingCollector,
  PROVIDER_ID,
  type ArchitectureRulesOptions,
  type SeverityOf,
} from './architecture-rules/shared.ts'

export {
  ARCHITECTURE_RULE_IDS,
  DEFAULT_DRIFT_TAG,
  EVIDENCE_LIMIT,
  PROVIDER_ID,
} from './architecture-rules/shared.ts'
export type {
  ArchitectureRuleId,
  ArchitectureRulesOptions,
  TypeOnlyImportsPolicy,
} from './architecture-rules/shared.ts'

/**
 * Returns a `NamedProvider`, ready to drop into a config's `validate` array.
 *
 * Options are validated here, at construction: a `severity` key naming a rule
 * that does not exist is an error with a suggestion, never an ignored key.
 * TypeScript catches the typo too, but only in a project that typechecks its
 * config, and a promotion that silently does nothing is a team believing
 * their gate is closed when it is open.
 */
export function architectureRules(
  options: ArchitectureRulesOptions = {},
): NamedProvider<ValidateProvider> {
  validateSeverity(options.severity)
  const severityOf: SeverityOf = (rule, standard) => options.severity?.[rule] ?? standard
  const driftTag = options.driftTag ?? DEFAULT_DRIFT_TAG
  const typeOnlyPolicy = options.typeOnlyImports ?? 'enforce'

  const run: ValidateProvider = async (context: ValidateContext): Promise<Finding[]> => {
    const observations = new Map(context.observations.map((item) => [item.id, item]))
    const declared = declaredRelationships(context.model)
    const drift = new DriftLedger(declared.byId.values(), driftTag)
    const collector = new FindingCollector()

    // Whether every dependency behind a boundary finding is type-only. Seeded
    // true on first sight and ANDed per contributing dependency, so a single
    // value import flips the whole edge to runtime coupling.
    const edgeIsTypeOnly = new Map<string, boolean>()

    // Exercised, declared element-level edges, for the cycle rule: the one
    // family of defect every per-edge rule passes quietly.
    const declaredEdges = new Map<string, DeclaredEdge>()

    for (const association of context.associations) {
      const observation = observations.get(association.observationId)
      if (observation === undefined) continue

      if (observation.kind === 'file') {
        collector.add(fileRule(association, observation, severityOf))
      } else if (observation.kind === 'dependency') {
        if (
          association.status === 'resolved' &&
          association.relationship !== undefined &&
          association.source?.id !== undefined &&
          association.target?.id !== undefined &&
          association.source.id !== association.target.id
        ) {
          const edge = { source: association.source.id, target: association.target.id }
          declaredEdges.set(`${edge.source}->${edge.target}`, edge)
        }
        const finding = dependencyRule(association, observation, declared, severityOf)
        if (finding !== undefined) {
          edgeIsTypeOnly.set(
            finding.id,
            (edgeIsTypeOnly.get(finding.id) ?? true) && isTypeOnlyDependency(observation),
          )
          collector.add(finding)
        }
        // A dependency the resolver could not place is a crossing the gate
        // never judged; saying so is the difference between an advisory miss
        // and a silent one.
        collector.add(unmappedReferenceRule(association, observation, severityOf))
        // Ignored means not counted anywhere: under 'ignore' a type-only
        // dependency must not keep a drift edge alive either.
        if (typeOnlyPolicy !== 'ignore' || !isTypeOnlyDependency(observation)) {
          drift.record(association, observation)
        }
      } else if (observation.kind === 'unresolved-dependency') {
        // A rescued abstention (see source-root's `rescuedByName`) resolved
        // onto two elements after all, so it is judged like any dependency;
        // only a genuinely unresolved one keeps the advisory finding.
        if (association.status === 'resolved') {
          const finding = dependencyRule(association, observation, declared, severityOf)
          if (finding !== undefined) {
            edgeIsTypeOnly.set(
              finding.id,
              (edgeIsTypeOnly.get(finding.id) ?? true) && isTypeOnlyDependency(observation),
            )
            collector.add(finding)
          }
          if (
            association.relationship !== undefined &&
            association.source?.id !== undefined &&
            association.target?.id !== undefined &&
            association.source.id !== association.target.id
          ) {
            const edge = { source: association.source.id, target: association.target.id }
            declaredEdges.set(`${edge.source}->${edge.target}`, edge)
          }
          if (typeOnlyPolicy !== 'ignore' || !isTypeOnlyDependency(observation)) {
            drift.record(association, observation)
          }
        } else {
          collector.add(unresolvedImportRule(association, observation, severityOf))
        }
      }
    }

    for (const finding of drift.findings(severityOf)) collector.add(finding)

    return [
      ...applyTypeOnlyPolicy(collector.findings(), edgeIsTypeOnly, typeOnlyPolicy),
      ...coverageRules(context, observations, severityOf),
      ...packageRules(context, observations, severityOf),
      ...circularDependencyRules(declaredEdges.values(), severityOf),
      ...unobservedElementsRule(context, severityOf),
      ...modelHygieneRules(declared, severityOf),
      ...vocabularyRules(context, severityOf),
    ]
  }

  return { id: PROVIDER_ID, run }
}

function validateSeverity(severity: ArchitectureRulesOptions['severity']): void {
  if (severity === undefined) return
  const known: readonly string[] = ARCHITECTURE_RULE_IDS

  for (const [rule, level] of Object.entries(severity)) {
    if (!known.includes(rule)) {
      const suggestion = closestName(rule, [...ARCHITECTURE_RULE_IDS])
      throw new Error(
        `architectureRules: 'severity' names unknown rule '${rule}'` +
          (suggestion === undefined ? '' : `, did you mean '${suggestion}'?`) +
          ` (see node_modules/@arocnies/fitc4/README.md#rules)`,
      )
    }
    if (!isSeverity(level)) {
      throw new Error(
        `architectureRules: 'severity.${rule}' must be one of ${SEVERITIES.join(', ')}`,
      )
    }
  }
}
