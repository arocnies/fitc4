import { describe, expect, test } from 'vitest'

import { renderReport, UNMAPPED_SOURCE_GROUP_THRESHOLD } from '../src/report.ts'
import type { Observation } from '../src/types.ts'
import { runFixture } from './helpers.ts'

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

    expect(report.text).toContain('src/ 5 · scripts/ 2 · lib/ 1')
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
