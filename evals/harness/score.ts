/**
 * Scoring: compare one pipeline result against a fixture's expectations file.
 *
 * An `expectations.json` carries two kinds of truth:
 *
 * - `findings` is the COMPLETE finding set of a perfect run. Every entry must
 *   match one emitted finding (a hit; otherwise a miss), and every emitted
 *   finding must be claimed by one entry (otherwise an extra) — so a
 *   deterministic rule that stops firing and a semantic reviewer that flags a
 *   healthy element are both visible, as a miss and an extra respectively.
 * - `associations.must` / `associations.mustNot` and `observations.must` /
 *   `observations.mustNot` pin the agent phases whose quality does not
 *   surface as findings: the mapping `agentResolve` must make, the abstention
 *   it must keep, the observations and attestation `agentScan` must report,
 *   and the noise it must not (a standard-library import the general import
 *   scan is told to skip stays silent in the gate, so only a named must-not
 *   can catch it).
 *
 * Scores are grouped per provider, because that is the unit of judgment: the
 * deterministic providers are expected to be exact, and each agent provider's
 * hits/misses/extras are its measurement. `mustNot` entries and unclaimed
 * agent output count as extras; matching is by content (rule, subject,
 * related ids), never by generated finding id, so unrelated model edits do
 * not churn the expectations.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Association, Finding, Observation, PipelineResult } from '@arocnies/fitc4'

export interface ExpectedFinding {
  provider: string
  ruleId: string
  severity?: string
  subject?: { kind?: string; id?: string }
  /** Element/ref ids that must all appear among the finding's `related` refs. */
  related?: string[]
  descriptionIncludes?: string
  /** Human label for the scorecard notes; a summary is derived when absent. */
  label?: string
}

export interface ExpectedAssociation {
  provider: string
  source?: string
  target?: string
  /** Matched against `data.candidateId` — the stable agent-resolve decision key. */
  candidateId?: string
  status?: string
  /** true: a declared relationship must back the edge; false: none may. */
  declared?: boolean
  label?: string
}

export interface ExpectedObservation {
  provider: string
  kind: string
  subject?: string
  target?: string
  /**
   * The citation the observation must carry, checked against the repository
   * itself: some evidence entry must name this `path`, and the file's line at
   * that entry's `line` must contain `lineIncludes`. This is the only place
   * the suite reads the cited line rather than trusting it, so pin it on the
   * observations whose whole value is the citation.
   */
  evidence?: { path: string; lineIncludes: string }
  label?: string
}

export interface Expectations {
  /** The complete finding set of a perfect run. */
  findings: ExpectedFinding[]
  /** Named regressions: matches are extras reported under this label. */
  findingsMustNot?: ExpectedFinding[]
  associations?: { must?: ExpectedAssociation[]; mustNot?: ExpectedAssociation[] }
  observations?: {
    must?: ExpectedObservation[]
    mustNot?: ExpectedObservation[]
    /**
     * Tolerated output: observations the reply contract permits but the ideal
     * reply does not require, such as a 'file' observation per focused file.
     * A match is claimed silently — no hit, no extra — so a model exercising
     * the permission does not lose the row, and one omitting it does not
     * either. Anything matching neither must, mustNot, nor may stays an
     * extra.
     */
    may?: ExpectedObservation[]
    /**
     * Declares the agent observation set open-ended: unclaimed agent
     * observations are tolerated instead of counted as extras. The default is
     * the strict reading, mirroring associations, because an agent scan's
     * unpinned chatter is otherwise invisible. Set this only where the ideal
     * observation set genuinely cannot be enumerated, and say why in the
     * fixture's docs.
     */
    openEnded?: boolean
  }
  /**
   * Provider ids that must be wired into the pipeline this row ran. This is
   * the tripwire for the quietest regression: a row whose provider produced
   * nothing scores identically whether the provider abstained correctly or
   * was never composed at all, unless its presence is asserted here.
   */
  providersMust?: string[]
  /**
   * false marks the row a FLOOR: a measured snapshot of what a configuration
   * currently produces, not a target to hold. The row is scored and printed,
   * drift is visible in the notes, and nothing fails on it — so improving the
   * shipped defaults shows up as drift to re-snapshot, never as a regression.
   */
  gate?: boolean
}

export interface ProviderScore {
  provider: string
  hits: number
  misses: number
  extras: number
  /**
   * How many of the misses and extras the fixture pinned as expected (see
   * `harness/draft.ts`). Pinned entries stay in their columns, so the counts
   * above are always truthful, but they do not fail the row.
   */
  pinned?: number
  /**
   * Pins that no longer describe the output: an expected miss that was
   * covered, an expected extra that never appeared. Always fails the row, so
   * a stale pin forces a fixture update instead of rotting silently.
   */
  stale?: number
  /** One line per miss and extra, ready for the scorecard details. */
  notes: string[]
}

export interface FixtureScore {
  fixture: string
  /** A run that never produced a result to score: model errors, load failure. */
  error?: string
  /** From `expectations.gate === false`: scored and printed, never failing. */
  floor?: boolean
  providers: ProviderScore[]
}

/** Agent providers get hit/miss/extra counts; everything else must be exact too. */
function isAgentProvider(provider: string): boolean {
  return provider.startsWith('agent-')
}

/** A row passes when every miss and extra is a pinned one and no pin is stale. */
export function rowOk(row: ProviderScore): boolean {
  return row.misses + row.extras === (row.pinned ?? 0) && (row.stale ?? 0) === 0
}

export function perfect(score: FixtureScore): boolean {
  if (score.error !== undefined) return false
  return score.providers.every(rowOk)
}

export interface ScoreOptions {
  /** Where evidence citations are checked against real files (see `ExpectedObservation.evidence`). */
  repositoryRoot?: string
}

export function scoreFixture(
  fixture: string,
  expectations: Expectations,
  result: PipelineResult,
  options: ScoreOptions = {},
): FixtureScore {
  const floor = expectations.gate === false ? { floor: true as const } : {}
  if (result.modelErrors.length > 0) {
    return { fixture, ...floor, error: `model errors: ${result.modelErrors.join('; ')}`, providers: [] }
  }

  const rows = new Map<string, ProviderScore>()
  const row = (provider: string): ProviderScore => {
    const existing = rows.get(provider)
    if (existing !== undefined) return existing
    const created: ProviderScore = { provider, hits: 0, misses: 0, extras: 0, notes: [] }
    rows.set(provider, created)
    return created
  }

  // --- providers: assert the roster before judging any output. A provider
  // that produced nothing scores identically whether it abstained correctly
  // or was never composed, so its presence in the pipeline is its own pin.
  const wired = new Set([...result.providers.scan, ...result.providers.resolve, ...result.providers.validate])
  for (const provider of expectations.providersMust ?? []) {
    if (wired.has(provider)) {
      row(provider).hits += 1
      continue
    }
    const target = row(provider)
    target.misses += 1
    target.notes.push('provider was not wired into the pipeline')
  }

  // --- findings: the complete expected set, matched greedily by content ---
  const claimed = new Set<Finding>()
  for (const expected of expectations.findings) {
    const match = result.findings.find(
      (finding) => !claimed.has(finding) && findingMatches(expected, finding),
    )
    if (match === undefined) {
      const target = row(expected.provider)
      target.misses += 1
      target.notes.push(`missing finding: ${describeExpectedFinding(expected)}`)
    } else {
      claimed.add(match)
      row(expected.provider).hits += 1
    }
  }
  for (const finding of result.findings) {
    if (claimed.has(finding)) continue
    const named = expectations.findingsMustNot?.find((entry) => findingMatches(entry, finding))
    const target = row(finding.provider)
    target.extras += 1
    target.notes.push(
      named?.label !== undefined
        ? `must-not finding appeared: ${named.label}`
        : `unexpected finding: [${finding.severity}] ${finding.ruleId}  ${finding.description}`,
    )
  }

  // --- associations: the agent-resolve mappings and abstentions ---
  const must = expectations.associations?.must ?? []
  const mustNot = expectations.associations?.mustNot ?? []
  const claimedAssociations = new Set<Association>()
  for (const expected of must) {
    const match = result.associations.find(
      (association) => !claimedAssociations.has(association) && associationMatches(expected, association),
    )
    if (match === undefined) {
      const target = row(expected.provider)
      target.misses += 1
      target.notes.push(`missing association: ${describeExpectedAssociation(expected)}`)
    } else {
      claimedAssociations.add(match)
      row(expected.provider).hits += 1
    }
  }
  for (const association of result.associations) {
    if (claimedAssociations.has(association)) continue
    const named = mustNot.find((entry) => associationMatches(entry, association))
    if (named !== undefined) {
      claimedAssociations.add(association)
      const target = row(association.provider)
      target.extras += 1
      target.notes.push(
        `must-not association appeared: ${named.label ?? describeExpectedAssociation(named)}`,
      )
      continue
    }
    // Deterministic resolvers legitimately emit associations the expectations
    // never name (file ownership, in-boundary edges). An AGENT resolver's
    // unclaimed mapping is a wrong answer: it mapped something the ideal
    // agent would not have.
    if (isAgentProvider(association.provider)) {
      const target = row(association.provider)
      target.extras += 1
      target.notes.push(`unexpected association: ${association.description ?? association.id}`)
    }
  }

  // --- observations: what the agent scan must have reported ---
  const claimedObservations = new Set<Observation>()
  for (const expected of expectations.observations?.must ?? []) {
    const match = result.observations.find(
      (observation) => !claimedObservations.has(observation) && observationMatches(expected, observation),
    )
    if (match === undefined) {
      const target = row(expected.provider)
      target.misses += 1
      target.notes.push(`missing observation: ${describeExpectedObservation(expected)}`)
      continue
    }
    claimedObservations.add(match)
    // The citation is checked against the repository, not taken on trust: a
    // matched observation whose pinned evidence line does not say what the
    // pin requires is a miss, because a wrong citation is a wrong answer
    // wearing a right one's ids.
    const evidenceProblem =
      expected.evidence === undefined
        ? undefined
        : checkEvidence(expected.evidence, match, options.repositoryRoot)
    if (evidenceProblem !== undefined) {
      const target = row(expected.provider)
      target.misses += 1
      target.notes.push(
        `evidence check failed for ${describeExpectedObservation(expected)}: ${evidenceProblem}`,
      )
      continue
    }
    row(expected.provider).hits += 1
  }
  // Unclaimed output, mirroring associations: a must-not observation that
  // appears is a named extra, and any OTHER unclaimed agent observation is an
  // unnamed one — an agent scan that pads its reply must lose the row rather
  // than pass quietly. Deterministic scanners legitimately enumerate files
  // the expectations never name, so only agent providers are held to the
  // complete set, and `openEnded: true` opts a fixture out where the ideal
  // set genuinely cannot be written down.
  const observationsMustNot = expectations.observations?.mustNot ?? []
  const observationsMay = expectations.observations?.may ?? []
  const openEnded = expectations.observations?.openEnded === true
  for (const observation of result.observations) {
    if (claimedObservations.has(observation)) continue
    if (observationsMay.some((entry) => observationMatches(entry, observation))) {
      claimedObservations.add(observation)
      continue
    }
    const named = observationsMustNot.find((entry) => observationMatches(entry, observation))
    if (named !== undefined) {
      claimedObservations.add(observation)
      const target = row(observation.provider)
      target.extras += 1
      target.notes.push(
        `must-not observation appeared: ${named.label ?? describeExpectedObservation(named)}`,
      )
      continue
    }
    if (openEnded || !isAgentProvider(observation.provider)) continue
    const target = row(observation.provider)
    target.extras += 1
    const summary = `${observation.kind}: ${observation.subject?.id ?? '?'}${observation.target !== undefined ? ` -> ${observation.target.id}` : ''}`
    target.notes.push(`unexpected observation: ${summary}`)
  }

  return { fixture, ...floor, providers: [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider)) }
}

/**
 * Why a pinned citation does not hold, or undefined when it does. The check
 * reads the cited file from the repository the pipeline actually ran on, so
 * it needs `repositoryRoot`; a pin in a fixture that never passes one is a
 * configuration mistake worth failing loudly.
 */
function checkEvidence(
  expected: { path: string; lineIncludes: string },
  observation: Observation,
  repositoryRoot: string | undefined,
): string | undefined {
  if (repositoryRoot === undefined) return 'no repositoryRoot was passed to the scorer'
  const entry = (observation.evidence ?? []).find((candidate) => candidate.path === expected.path)
  if (entry === undefined) return `no evidence entry cites ${expected.path}`
  let content: string
  try {
    content = fs.readFileSync(path.join(repositoryRoot, expected.path), 'utf8')
  } catch {
    return `cited file ${expected.path} is unreadable under the repository root`
  }
  // A citation without a line number is weaker but still checkable: the
  // cited FILE must contain the pinned text somewhere. With a line, the
  // check is exact, and a wrong line fails even when the file would match.
  if (entry.line === undefined) {
    if (!content.includes(expected.lineIncludes)) {
      return `${expected.path} nowhere contains '${expected.lineIncludes}'`
    }
    return undefined
  }
  const line = content.split(/\r?\n/)[entry.line - 1]
  if (line === undefined) return `cited line ${entry.line} is past the end of ${expected.path}`
  if (!line.includes(expected.lineIncludes)) {
    return `line ${entry.line} of ${expected.path} does not contain '${expected.lineIncludes}'`
  }
  return undefined
}

function findingMatches(expected: ExpectedFinding, finding: Finding): boolean {
  if (finding.provider !== expected.provider) return false
  if (finding.ruleId !== expected.ruleId) return false
  if (expected.severity !== undefined && finding.severity !== expected.severity) return false
  if (expected.subject?.kind !== undefined && finding.subject?.kind !== expected.subject.kind) {
    return false
  }
  if (expected.subject?.id !== undefined && finding.subject?.id !== expected.subject.id) {
    return false
  }
  if (expected.related !== undefined) {
    const ids = new Set((finding.related ?? []).map((ref) => ref.id))
    if (!expected.related.every((id) => ids.has(id))) return false
  }
  if (
    expected.descriptionIncludes !== undefined &&
    !finding.description.includes(expected.descriptionIncludes)
  ) {
    return false
  }
  return true
}

function associationMatches(expected: ExpectedAssociation, association: Association): boolean {
  if (association.provider !== expected.provider) return false
  if (expected.source !== undefined && association.source?.id !== expected.source) return false
  if (expected.target !== undefined && association.target?.id !== expected.target) return false
  if (expected.status !== undefined && association.status !== expected.status) return false
  if (expected.candidateId !== undefined && association.data?.['candidateId'] !== expected.candidateId) {
    return false
  }
  if (expected.declared !== undefined && (association.relationship !== undefined) !== expected.declared) {
    return false
  }
  return true
}

function observationMatches(expected: ExpectedObservation, observation: Observation): boolean {
  if (observation.provider !== expected.provider) return false
  if (observation.kind !== expected.kind) return false
  if (expected.subject !== undefined && observation.subject?.id !== expected.subject) return false
  if (expected.target !== undefined && observation.target?.id !== expected.target) return false
  return true
}

function describeExpectedFinding(expected: ExpectedFinding): string {
  if (expected.label !== undefined) return expected.label
  const subject = expected.subject?.id !== undefined ? ` on ${expected.subject.id}` : ''
  const related = expected.related !== undefined ? ` (${expected.related.join(' -> ')})` : ''
  return `${expected.ruleId}${subject}${related}`
}

function describeExpectedAssociation(expected: ExpectedAssociation): string {
  if (expected.label !== undefined) return expected.label
  if (expected.candidateId !== undefined) return `decision ${expected.candidateId}`
  return `${expected.source ?? '?'} -> ${expected.target ?? '?'}`
}

function describeExpectedObservation(expected: ExpectedObservation): string {
  if (expected.label !== undefined) return expected.label
  const target = expected.target !== undefined ? ` -> ${expected.target}` : ''
  return `${expected.kind}: ${expected.subject ?? '?'}${target}`
}

/** Render the scorecard table plus the miss/extra details beneath it. */
export function renderScorecard(scores: FixtureScore[]): string {
  const header = ['fixture', 'provider', 'hits', 'misses', 'extras', 'result']
  const table: string[][] = [header]

  for (const score of scores) {
    if (score.error !== undefined) {
      table.push([score.fixture, '(run failed)', '-', '-', '-', score.floor === true ? 'floor(broken)' : 'FAIL'])
      continue
    }
    // A fixture with no provider rows must still occupy a line: a row that
    // scored nothing at all vanishing from the table is the empty-provider
    // illusion, one layer up.
    if (score.providers.length === 0) {
      table.push([score.fixture, '(nothing scored)', '0', '0', '0', score.floor === true ? 'floor' : 'ok'])
      continue
    }
    for (const provider of score.providers) {
      table.push([
        score.fixture,
        provider.provider,
        String(provider.hits),
        String(provider.misses),
        String(provider.extras),
        score.floor === true
          ? rowOk(provider)
            ? 'floor'
            : 'floor(drift)'
          : rowOk(provider)
            ? 'ok'
            : 'FAIL',
      ])
    }
  }

  const widths = header.map((_, column) => Math.max(...table.map((line) => line[column]?.length ?? 0)))
  const rendered = table.map((line) =>
    line.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd(),
  )
  rendered.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('  '))

  const details: string[] = []
  for (const score of scores) {
    if (score.error !== undefined) {
      details.push(`${score.fixture}: ${score.error}`)
      continue
    }
    for (const provider of score.providers) {
      for (const note of provider.notes) {
        details.push(`${score.fixture}  ${provider.provider}: ${note}`)
      }
    }
  }

  return details.length === 0
    ? rendered.join('\n')
    : `${rendered.join('\n')}\n\n${details.join('\n')}`
}
