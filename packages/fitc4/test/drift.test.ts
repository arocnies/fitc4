import { beforeAll, describe, expect, test } from 'vitest'

import type { PipelineResult } from '../src/pipeline.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import { exitCodeFor, renderReport } from '../src/report.ts'
import { findingFor, ruleIds, runFixture } from './helpers.ts'

// Declared drift: a brownfield repo declares the edges the code actually
// has but the target architecture does not want, tagged in the model. Tagged
// edges are permitted but counted; an edge nothing exercises must be deleted.
describe('declared drift', () => {
  // One shared default run; only the override tests re-run the pipeline.
  let drift: PipelineResult
  beforeAll(async () => {
    drift = await runFixture('drift')
  })

  test('a drift-tagged relationship permits the dependencies it covers', () => {
    const { findings } = drift

    expect(findingFor(findings, 'missing-relationship')).toBeUndefined()
    expect(findingFor(findings, 'relationship-direction')).toBeUndefined()
    expect(ruleIds(findings)).toEqual(['drift-relationship', 'unused-drift'])
  })

  test('an exercised drift edge is one info finding carrying its traffic', () => {
    const { findings } = drift

    const finding = findingFor(findings, 'drift-relationship')
    expect(finding?.severity).toBe('info')
    expect(finding?.subject).toEqual({
      kind: 'relationship',
      id: 'fixture.legacy::_::fixture.core',
    })
    // Two legacy files still ride the edge; the count is in the message so a
    // reader sees the burn-down direction without counting evidence lines.
    expect(finding?.description).toContain('2 dependencies still ride')
    expect(finding?.description).toContain('delete the tagged relationship')
    expect(finding?.evidence?.map((entry) => entry.path).sort()).toEqual([
      'src/legacy/old.ts',
      'src/legacy/older.ts',
    ])
  })

  // How the declared set shrinks: the code no longer does this, so the model
  // must stop tolerating it.
  test('a drift edge nothing exercises anymore demands deletion', () => {
    const { findings } = drift

    const finding = findingFor(findings, 'unused-drift')
    expect(finding?.severity).toBe('warning')
    expect(finding?.subject).toEqual({
      kind: 'relationship',
      id: 'fixture.interface::_::fixture.legacy',
    })
    expect(finding?.description).toContain('Delete the relationship')
  })

  test('tolerated drift does not fail the gate by default', () => {
    expect(exitCodeFor(drift)).toBe(0)
  })

  test('the report prints a burn-down derived from the findings', () => {
    const report = renderReport(drift)
    expect(report.text).toContain('drift: 2 declared, 1 exercised, 1 unused')
  })

  test('a model with no drift edges prints no burn-down', async () => {
    expect(renderReport(await runFixture('ok')).text).not.toContain('drift:')
  })

  // Promoting drift-relationship to error is "forbid all drift": the tagged
  // edges stay declared, but exercising any of them fails the gate.
  test('a severity override turns exercised drift into a gate failure', async () => {
    const result = await runFixture('drift', {
      validate: [architectureRules({ severity: { 'drift-relationship': 'error' } })],
    })

    expect(findingFor(result.findings, 'drift-relationship')?.severity).toBe('error')
    expect(exitCodeFor(result)).toBe(1)
  })

  // Promoted to error: an edge the code stopped exercising fails the gate until
  // it is deleted from the model.
  test('a severity override turns unused drift into a gate failure', async () => {
    const result = await runFixture('drift', {
      validate: [architectureRules({ severity: { 'unused-drift': 'error' } })],
    })

    expect(findingFor(result.findings, 'unused-drift')?.severity).toBe('error')
    expect(exitCodeFor(result)).toBe(1)
  })

  // Only the configured tag marks debt. With another tag configured, the
  // drift-tagged relationships are ordinary declared relationships: they still
  // permit, and nothing is counted.
  test('a custom driftTag stops interpreting the default tag', async () => {
    const result = await runFixture('drift', {
      validate: [architectureRules({ driftTag: 'legacy-debt' })],
    })

    expect(result.findings).toEqual([])
    expect(renderReport(result).text).not.toContain('drift:')
  })
})
