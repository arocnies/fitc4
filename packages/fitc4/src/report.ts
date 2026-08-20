/**
 * Report rendering and the gate decision.
 *
 * The renderer reads only the common finding envelope. It never interprets a
 * provider's `data`. That stays owned by the provider that emitted it, so a
 * provider can change its private shape without breaking the report.
 */

import { SEVERITIES, isSeverity, type Evidence, type Finding, type Severity } from './types.ts'
import type { PipelineResult } from './pipeline.ts'

export interface Report {
  text: string
  exitCode: number
}

/**
 * Above this many `unmapped-source` findings, the report renders one grouped
 * block instead of a block per file. Rendering only: `--json` keeps every
 * finding, so structured consumers see each file. A brownfield repo's 450
 * unowned files are one adoption fact, not 450 separate ones.
 */
export const UNMAPPED_SOURCE_GROUP_THRESHOLD = 5

/** How many individual paths the grouped `unmapped-source` block lists. */
const UNMAPPED_SOURCE_LISTED_PATHS = 10

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

  // A reader mid-failure, human or agent, should not have to hunt for what
  // a rule means. The shipped README documents every rule and its fixes, and
  // the local path works offline.
  if (result.findings.length > 0) {
    lines.push('rules: node_modules/fitc4/README.md#rules')
    lines.push('')
  }

  for (const severity of SEVERITIES) {
    const findings = result.findings.filter((finding) => finding.severity === severity)
    if (findings.length === 0) continue

    // Findings stay per-file in `--json`; only the rendering collapses.
    const unmapped = findings.filter((finding) => finding.ruleId === 'unmapped-source')
    const grouped = unmapped.length > UNMAPPED_SOURCE_GROUP_THRESHOLD
    const rendered = grouped
      ? findings.filter((finding) => finding.ruleId !== 'unmapped-source')
      : findings

    lines.push(`${severity} (${findings.length})`)
    if (grouped) lines.push(...groupedUnmappedBlock(unmapped))
    for (const finding of sortById(rendered)) {
      lines.push(`  ${finding.ruleId}  ${finding.description}`)
      lines.push(`    ${finding.provider} · ${finding.id}`)
      for (const evidence of finding.evidence ?? []) {
        lines.push(`    ${formatEvidence(evidence)}`)
      }
    }
    lines.push('')
  }

  lines.push(...driftBurnDown(result.findings))

  // Who judged the run is part of the run. A config that replaced a phase is
  // visible here, not only in the file that did it, whether it replaced the
  // phase deliberately or by forgetting to spread the defaults back in.
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

/**
 * One block for many unowned files: total, a by-directory breakdown, and a
 * sample of paths. The per-file detail is still one `--json` away.
 */
function groupedUnmappedBlock(unmapped: Finding[]): string[] {
  const paths = unmapped
    .map((finding) => finding.subject?.id ?? '(unknown)')
    .sort((a, b) => a.localeCompare(b))

  const byDirectory = new Map<string, number>()
  for (const filePath of paths) {
    const top = filePath.includes('/') ? `${filePath.split('/')[0]}/` : './'
    byDirectory.set(top, (byDirectory.get(top) ?? 0) + 1)
  }
  const breakdown = [...byDirectory]
    .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([directory, count]) => `${directory} ${count}`)
    .join(' · ')

  const provider = unmapped[0]?.provider ?? 'architecture-rules'
  const lines = [
    `  unmapped-source  ${unmapped.length} files are not owned by any model element.`,
    `    ${provider} · ${unmapped.length} findings (grouped; --json lists each file)`,
    `    ${breakdown}`,
    ...paths.slice(0, UNMAPPED_SOURCE_LISTED_PATHS).map((filePath) => `    ${filePath}`),
  ]
  if (paths.length > UNMAPPED_SOURCE_LISTED_PATHS) {
    lines.push(`    +${paths.length - UNMAPPED_SOURCE_LISTED_PATHS} more`)
  }
  return lines
}

/**
 * The declared drift burn-down, derived from the findings alone so a `--json`
 * consumer computes the identical numbers: every drift edge yields exactly one
 * `drift-relationship` (exercised) or `unused-drift` (unused) finding.
 */
function driftBurnDown(findings: Finding[]): string[] {
  const exercised = findings.filter((finding) => finding.ruleId === 'drift-relationship').length
  const unused = findings.filter((finding) => finding.ruleId === 'unused-drift').length
  const declared = exercised + unused
  if (declared === 0) return []
  return [`drift: ${declared} declared · ${exercised} exercised · ${unused} unused`]
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
function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) {
    counts[isSeverity(finding.severity) ? finding.severity : 'error'] += 1
  }
  return counts
}
