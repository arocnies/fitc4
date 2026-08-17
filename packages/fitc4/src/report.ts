/**
 * Report rendering and the gate decision.
 *
 * The renderer reads only the common finding envelope. It never interprets a
 * provider's `data` — that stays owned by the provider that emitted it
 * (POC-DESIGN-v4).
 */

import { SEVERITIES, isSeverity, type Evidence, type Finding, type Severity } from './types.ts'
import type { PipelineResult } from './pipeline.ts'

export interface Report {
  text: string
  exitCode: number
}

/** The single definition of the gate, shared by the text and JSON paths. */
export function exitCodeFor(result: PipelineResult): number {
  if (result.modelErrors.length > 0) return 1
  return result.findings.some((finding) => finding.severity === 'error') ? 1 : 0
}

export function renderReport(result: PipelineResult): Report {
  const exitCode = exitCodeFor(result)

  if (result.modelErrors.length > 0) {
    const lines = [
      'LikeC4 model is invalid; the architecture pipeline did not run.',
      '',
      ...result.modelErrors.map((error) => `  ${error}`),
    ]
    return { text: lines.join('\n'), exitCode }
  }

  const counts = countBySeverity(result.findings)
  const lines: string[] = []

  for (const severity of SEVERITIES) {
    const findings = result.findings.filter((finding) => finding.severity === severity)
    if (findings.length === 0) continue

    lines.push(`${severity} (${findings.length})`)
    for (const finding of sortById(findings)) {
      lines.push(`  ${finding.ruleId}  ${finding.description}`)
      lines.push(`    ${finding.provider} · ${finding.id}`)
      for (const evidence of finding.evidence ?? []) {
        lines.push(`    ${formatEvidence(evidence)}`)
      }
    }
    lines.push('')
  }

  // Who judged the run is part of the run. A config that replaced a phase —
  // deliberately or by forgetting to spread the preset back in — is visible
  // here, not only in the file that did it.
  lines.push(
    `scan ${result.providers.scan.join(', ')} · ` +
      `resolve ${result.providers.resolve.join(', ')} · ` +
      `validate ${result.providers.validate.join(', ')}`,
  )
  lines.push(
    `${result.observations.length} observations · ` +
      `${result.associations.length} associations · ` +
      `${counts.error} errors, ${counts.warning} warnings, ${counts.info} info`,
  )

  return { text: lines.join('\n'), exitCode }
}

function formatEvidence(evidence: Evidence): string {
  const location =
    evidence.path === undefined
      ? undefined
      : evidence.line === undefined
        ? evidence.path
        : `${evidence.path}:${evidence.line}`

  return [location, evidence.detail].filter((part) => part !== undefined).join('  ')
}

function sortById(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Count by severity.
 *
 * An unrecognized severity counts as an error rather than creating a stray key,
 * so a miscounted finding can never make the summary look clean. The pipeline
 * already rewrites these, but the renderer does not assume that.
 */
export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) {
    counts[isSeverity(finding.severity) ? finding.severity : 'error'] += 1
  }
  return counts
}
