import { describe, expect, test } from 'vitest'

import { runPipeline } from '../src/pipeline.ts'
import { EVIDENCE_LIMIT } from '../src/providers/architecture-rules.ts'
import { exitCodeFor, renderReport, UNMAPPED_SOURCE_GROUP_THRESHOLD } from '../src/report.ts'
import type { Association, Observation, ValidateProvider } from '../src/types.ts'
import { findingFor, fixtureConfig, runFixture, RULES_ID } from './helpers.ts'

/** A scan whose files are owned by no element of the `ok` model. */
function unownedScan(paths: string[]) {
  const observations: Observation[] = paths.map((path) => ({
    id: `file:${path}`,
    kind: 'file',
    subject: { kind: 'file', id: path },
    evidence: [{ path }],
    provider: 'mock-unowned-scan',
  }))
  return { scan: [{ id: 'mock-unowned-scan', run: async () => observations }] }
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

// A brownfield repo with hundreds of unowned files is one adoption fact, not
// hundreds of separate ones. The collapse is rendering only: `--json` keeps
// every finding.
describe('unmapped-source grouping in the report', () => {
  const over = [
    'src/one.ts',
    'src/two.ts',
    'src/three.ts',
    'src/four.ts',
    'src/five.ts',
    'scripts/six.ts',
    'scripts/seven.ts',
    'lib/eight.ts',
  ]

  test('over the threshold, one grouped block replaces the per-file blocks', async () => {
    const result = await runFixture('ok', unownedScan(over))
    const report = renderReport(result)

    expect(over.length).toBeGreaterThan(UNMAPPED_SOURCE_GROUP_THRESHOLD)
    expect(report.text).toContain('8 files are not owned by any model element')
    // One rule line for the group, not one per file.
    expect(occurrences(report.text, 'unmapped-source')).toBe(1)
  })

  test('the grouped block breaks the total down by top-level directory', async () => {
    const report = renderReport(await runFixture('ok', unownedScan(over)))

    expect(report.text).toContain('src/ 5, scripts/ 2, lib/ 1')
  })

  test('findings stay per-file for --json consumers', async () => {
    const result = await runFixture('ok', unownedScan(over))

    expect(
      result.findings.filter((finding) => finding.ruleId === 'unmapped-source'),
    ).toHaveLength(8)
  })

  test('the listed paths are capped with a remainder', async () => {
    const many = Array.from({ length: 14 }, (_, index) => `src/file${String(index).padStart(2, '0')}.ts`)
    const report = renderReport(await runFixture('ok', unownedScan(many)))

    expect(report.text).toContain('14 files are not owned')
    expect(report.text).toContain('src/file00.ts')
    expect(report.text).toContain('src/file09.ts')
    expect(report.text).not.toContain('src/file10.ts')
    expect(report.text).toContain('+4 more')
  })

  test('at or under the threshold every file keeps its own block', async () => {
    const under = over.slice(0, UNMAPPED_SOURCE_GROUP_THRESHOLD)
    const report = renderReport(await runFixture('ok', unownedScan(under)))

    expect(occurrences(report.text, 'unmapped-source  ')).toBe(under.length)
    expect(report.text).not.toContain('files are not owned')
  })

  test('the rules pointer line survives grouping', async () => {
    const report = renderReport(await runFixture('ok', unownedScan(over)))

    expect(report.text).toContain('rules: node_modules/fitc4/README.md#rules')
  })
})

describe('report', () => {
  test('advisory findings are reported without failing the gate', async () => {
    const advisory: ValidateProvider = async () => [
      {
        id: 'hint',
        ruleId: 'mock/semantic-hint',
        severity: 'info',
        description: 'Interface looks like a facade over Core.',
        subject: { kind: 'element', id: 'fixture.app.interface' },
        provider: 'mock-semantic-validation',
      },
    ]

    const result = await runFixture('ok', {
      validate: [
        { id: RULES_ID, run: architectureRulesProvider() },
        { id: 'mock-semantic-validation', run: advisory },
      ],
    })
    const report = renderReport(result)

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['mock/semantic-hint'])
    expect(report.exitCode).toBe(0)
    expect(report.text).toContain('Interface looks like a facade over Core.')
  })

  // A reader mid-failure — human or agent — should not have to hunt for what
  // a rule means; a clean run has nothing to look up.
  test('a report with findings points at the rule reference; a clean one does not', async () => {
    expect(renderReport(await runFixture('ok')).text).not.toContain('rules:')
    expect(renderReport(await runFixture('violations')).text).toContain(
      'rules: node_modules/fitc4/README.md#rules',
    )
  })

  test('evidence is capped so one boundary cannot bury the report', async () => {
    const crossings = EVIDENCE_LIMIT + 5
    const observations: Observation[] = []
    const associations: Association[] = []

    for (let index = 0; index < crossings; index += 1) {
      const observation: Observation = {
        id: `dependency:${index}`,
        kind: 'dependency',
        subject: { kind: 'file', id: `src/a/f${index}.ts` },
        target: { kind: 'file', id: 'src/b/g.ts' },
        evidence: [{ path: `src/a/f${index}.ts`, line: 1 }],
        provider: 'mock-scan',
      }
      observations.push(observation)
      associations.push({
        id: `association:${index}`,
        observationId: `mock-scan/dependency:${index}`,
        status: 'resolved',
        source: { kind: 'element', id: 'fixture.app.interface' },
        target: { kind: 'element', id: 'fixture.app.extra' },
        provider: 'mock-resolve',
      })
    }

    const result = await runPipeline(
      fixtureConfig('ok', {
        scan: [{ id: 'mock-scan', run: async () => observations }],
        resolve: [{ id: 'mock-resolve', run: async () => associations }],
      }),
    )

    const finding = findingFor(result.findings, 'missing-relationship')
    expect(finding?.evidence).toHaveLength(EVIDENCE_LIMIT + 1)
    expect(finding?.evidence?.at(-1)?.detail).toBe('and 5 more')
  })

  test('the scan provider keeps its own evidence array', async () => {
    const result = await runFixture('violations')

    const finding = findingFor(result.findings, 'missing-relationship')
    const observation = result.observations.find(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/extra/uses.ts',
    )
    expect(finding?.evidence).not.toBe(observation?.evidence)
  })

  test('evidence with no path renders without the literal word undefined', async () => {
    const noPath: ValidateProvider = async () => [
      {
        id: 'e',
        ruleId: 'mock/evidence',
        severity: 'info',
        description: 'detail only',
        evidence: [{ detail: 'somewhere' }],
        provider: 'mock-evidence',
      },
    ]

    const report = renderReport(
      await runFixture('ok', { validate: [{ id: 'mock-evidence', run: noPath }] }),
    )
    expect(report.text).not.toContain('undefined')
    expect(report.text).toContain('somewhere')
  })

  test('an invalid model reports the model error and does not run the pipeline', async () => {
    const result = await runPipeline(fixtureConfig('no-model'))
    const report = renderReport(result)

    expect(result.observations).toEqual([])
    expect(report.text).toContain('did not run')
    expect(report.exitCode).toBe(1)
  })
})

function architectureRulesProvider() {
  return fixtureConfig('ok').validate[0]?.run as ValidateProvider
}
