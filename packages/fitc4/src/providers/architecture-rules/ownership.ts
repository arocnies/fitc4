/**
 * Ownership rules: files and the `sources` metadata that claims them.
 *
 * `unmapped-source`, `ambiguous-source`, `invalid-sources`,
 * `unmatched-sources`.
 */

import { findingId } from '../../ids.ts'
import {
  isFragmentClaim,
  matchesClaim,
  ownershipPrefixes,
  type OwnershipPrefix,
} from '../../model.ts'
import type { Association, Observation, ValidateContext } from '../../types.ts'
import { PROVIDER_ID, type Evidence, type Finding, type SeverityOf } from './shared.ts'

export function fileRule(
  association: Association,
  observation: Observation,
  severityOf: SeverityOf,
): Finding | undefined {
  const filePath = observation.subject?.id
  if (filePath === undefined) return undefined
  const evidence: Evidence[] = [{ path: filePath }]

  if (association.status === 'unresolved') {
    return {
      id: findingId(PROVIDER_ID, 'unmapped-source', filePath),
      ruleId: 'unmapped-source',
      severity: severityOf('unmapped-source', 'warning'),
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
      severity: severityOf('ambiguous-source', 'error'),
      description: `${filePath} is claimed by ${candidates.map((ref) => ref.id).join(' and ')}.`,
      subject: { kind: 'file', id: filePath },
      related: candidates,
      evidence,
      provider: PROVIDER_ID,
    }
  }

  return undefined
}

/**
 * Ownership metadata that claims nothing.
 *
 * Without this the gate fails open. A typo in `sources`, a stray `./`, a glob
 * the prefix matcher cannot honour, or a renamed directory silently stops
 * matching, every dependency becomes unresolvable, and the run goes green with
 * only warnings.
 */
export function coverageRules(
  context: ValidateContext,
  observations: Map<string, Observation>,
  severityOf: SeverityOf,
): Finding[] {
  const { prefixes, rejected } = ownershipPrefixes(context.model)
  const findings: Finding[] = []

  for (const entry of rejected) {
    findings.push({
      id: findingId(PROVIDER_ID, 'invalid-sources', `${entry.elementId}/${entry.declared}`),
      ruleId: 'invalid-sources',
      severity: severityOf('invalid-sources', 'error'),
      description: `${entry.elementId} declares sources '${entry.declared}', which ${entry.reason}.`,
      subject: { kind: 'element', id: entry.elementId },
      provider: PROVIDER_ID,
    })
  }

  const all = [...observations.values()]

  const unmatched = (entry: OwnershipPrefix): Finding => ({
    id: findingId(PROVIDER_ID, 'unmatched-sources', `${entry.elementId}/${entry.declared}`),
    ruleId: 'unmatched-sources',
    severity: severityOf('unmatched-sources', 'error'),
    description: `${entry.elementId} declares sources '${entry.declared}', which matches no scanned file.`,
    subject: { kind: 'element', id: entry.elementId },
    provider: PROVIDER_ID,
  })

  // Fragment claims are matched by the subject and target ids of the scan's
  // observations rather than by scanned files, and are judged only when the
  // scan attested to examining the claim's file: a fragment inside a file
  // nothing examined is outside the scan, the same legal state as a directory
  // outside the scan roots. A claim inside an examined file that no
  // observation touches is the fragment-side fail-open: a typo'd locator
  // would otherwise silently gate nothing.
  const fragmentSubjects = new Set<string>()
  for (const observation of all) {
    for (const ref of [observation.subject, observation.target]) {
      if (ref?.kind === 'file' && ref.id.includes('#')) fragmentSubjects.add(ref.id)
    }
  }
  const examined = new Set(
    all
      .filter((observation) => observation.kind === 'scan-root')
      .map((observation) => observation.subject?.id ?? ''),
  )
  for (const entry of prefixes.filter((candidate) => isFragmentClaim(candidate.prefix))) {
    if ([...fragmentSubjects].some((subject) => matchesClaim(entry.prefix, subject))) continue
    if (!examined.has(entry.prefix.slice(0, entry.prefix.indexOf('#')))) continue
    findings.push(unmatched(entry))
  }

  const directoryPrefixes = prefixes.filter((candidate) => !isFragmentClaim(candidate.prefix))
  const scanned = all
    .filter((observation) => observation.kind === 'file')
    .map((observation) => observation.subject?.id ?? '')

  // With nothing scanned, every prefix trivially matches nothing. That says
  // something about the scan, not about the model, and whatever broke the scan
  // has already reported itself.
  if (scanned.length === 0) return findings

  // Only judge ownership the scan actually covered. A component may own code
  // outside the scan roots, the same legal state as an element with no
  // `sources` at all, and reporting that would leave the author no fix but to
  // delete truthful metadata.
  const covered = all
    .filter((observation) => observation.kind === 'scan-root')
    .map((observation) => {
      const root = observation.subject?.id ?? ''
      return root === '' || root === '.' ? '' : `${root.replace(/\/+$/, '')}/`
    })

  for (const entry of directoryPrefixes) {
    if (scanned.some((filePath) => filePath.startsWith(entry.prefix))) continue
    if (!covered.some((root) => entry.prefix.startsWith(root) || root.startsWith(entry.prefix))) {
      continue
    }
    findings.push(unmatched(entry))
  }

  return findings
}
