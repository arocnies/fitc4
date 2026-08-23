/**
 * Package rules: external packages and the `packages` metadata that claims
 * them.
 *
 * `invalid-packages`, `ambiguous-package`, `unmatched-packages`.
 */

import { findingId } from '../../ids.ts'
import { packageClaims, packageNameOf } from '../../model.ts'
import type { Observation, ValidateContext } from '../../types.ts'
import { PROVIDER_ID, type Finding, type SeverityOf } from './shared.ts'

/**
 * Package claims that gate nothing.
 *
 * The same fail-open family as `coverageRules`, on the package side: a typo'd
 * claim (`postgres` for `pg`, a subpath, an empty string) silently claims
 * nothing, every import of the real package stays unrestricted, and the run
 * goes green. Each broken claim is an error instead.
 */
export function packageRules(
  context: ValidateContext,
  observations: Map<string, Observation>,
  severityOf: SeverityOf,
): Finding[] {
  const { claims, rejected } = packageClaims(context.model)
  const findings: Finding[] = []

  for (const entry of rejected) {
    findings.push({
      id: findingId(PROVIDER_ID, 'invalid-packages', `${entry.elementId}/${entry.declared}`),
      ruleId: 'invalid-packages',
      severity: severityOf('invalid-packages', 'error'),
      description: `${entry.elementId} declares packages '${entry.declared}', which ${entry.reason}.`,
      subject: { kind: 'element', id: entry.elementId },
      provider: PROVIDER_ID,
    })
  }

  const claimantsByName = new Map<string, string[]>()
  for (const claim of claims) {
    claimantsByName.set(claim.name, [...(claimantsByName.get(claim.name) ?? []), claim.elementId])
  }

  // Two elements claiming one package is genuine ambiguity in the model: every
  // import of it resolves to no single element, so nothing gets judged.
  for (const [name, elementIds] of claimantsByName) {
    if (elementIds.length < 2) continue
    const sorted = [...elementIds].sort()
    findings.push({
      id: findingId(PROVIDER_ID, 'ambiguous-package', name),
      ruleId: 'ambiguous-package',
      severity: severityOf('ambiguous-package', 'error'),
      description: `Package '${name}' is claimed by ${sorted.join(' and ')}.`,
      subject: { kind: 'module', id: name },
      related: sorted.map((id) => ({ kind: 'element', id })),
      provider: PROVIDER_ID,
    })
  }

  const all = [...observations.values()]

  // With nothing scanned, every claim trivially matches nothing. That says
  // something about the scan, not about the model, and whatever broke the scan
  // has already reported itself. Same guard as `coverageRules`.
  if (!all.some((observation) => observation.kind === 'file')) return findings

  const imported = new Set(
    all
      .filter(
        (observation) =>
          observation.kind === 'dependency' && observation.target?.kind === 'module',
      )
      .map((observation) => packageNameOf(observation.target?.id ?? '')),
  )

  for (const claim of claims) {
    if (imported.has(claim.name)) continue
    findings.push({
      id: findingId(PROVIDER_ID, 'unmatched-packages', `${claim.elementId}/${claim.declared}`),
      ruleId: 'unmatched-packages',
      severity: severityOf('unmatched-packages', 'error'),
      description: `${claim.elementId} claims package '${claim.declared}', which no scanned file imports.`,
      subject: { kind: 'element', id: claim.elementId },
      provider: PROVIDER_ID,
    })
  }

  return findings
}
