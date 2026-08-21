/**
 * Type-only imports: the scanner records what is erased at compile time, and
 * the rules decide what it means. A domain file importing only an interface
 * from infrastructure is a different fact from importing the implementation,
 * and a tool that cannot tell them apart earns its first "your tool is wrong"
 * bug report. The edge is the unit: it is type-only only when every
 * contributing dependency is.
 */

import { beforeAll, describe, expect, test } from 'vitest'

import type { PipelineResult } from '../src/pipeline.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import type { Finding, Observation } from '../src/types.ts'
import { runFixture } from './helpers.ts'

/** The dependency observations out of one file of the type-only fixture. */
function dependenciesFrom(observations: Observation[], subject: string): Observation[] {
  return observations.filter(
    (item) => item.kind === 'dependency' && item.subject?.id === subject,
  )
}

function boundaryFinding(
  findings: Finding[],
  ruleId: string,
  sourceId: string,
): Finding | undefined {
  return findings.find(
    (finding) => finding.ruleId === ruleId && finding.subject?.id === sourceId,
  )
}

describe('the scanner records type-only imports', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('type-only')
  })

  test('a type-only import clause is type-only', () => {
    const clause = dependenciesFrom(result.observations, 'src/legacy/old.ts')
    expect(clause).toHaveLength(1)
    expect(clause[0]?.data?.['typeOnly']).toBe(true)
  })

  test('named bindings that are all type-only specifiers are type-only', () => {
    const fromInterface = dependenciesFrom(result.observations, 'src/interface/index.ts')
    const allSpecifiers = fromInterface.find(
      (item) => item.data?.['dependencyKind'] === 'import' && item.evidence?.[0]?.line === 5,
    )
    expect(allSpecifiers?.data?.['typeOnly']).toBe(true)
  })

  test('a type-only re-export is type-only', () => {
    const fromInterface = dependenciesFrom(result.observations, 'src/interface/index.ts')
    const reExport = fromInterface.find((item) => item.data?.['dependencyKind'] === 're-export')
    expect(reExport?.data?.['typeOnly']).toBe(true)
  })

  test('a mixed import is a value import', () => {
    const fromMixed = dependenciesFrom(result.observations, 'src/mixed/index.ts')
    expect(fromMixed.length).toBeGreaterThan(1)
    expect(fromMixed.every((item) => item.data?.['typeOnly'] === false)).toBe(true)
  })
})

describe("the default 'enforce' policy", () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('type-only')
  })

  // Unchanged behavior by default: the crossing is still an error. What
  // changes is honesty: the message says what actually crossed.
  test('a purely type-only edge is still an error, marked (type-only)', () => {
    const finding = boundaryFinding(result.findings, 'missing-relationship', 'fixture.interface')
    expect(finding?.severity).toBe('error')
    expect(finding?.description).toContain('(type-only)')
  })

  test('a reversed type-only edge is marked the same way', () => {
    const finding = boundaryFinding(
      result.findings,
      'relationship-direction',
      'fixture.reversed',
    )
    expect(finding?.severity).toBe('error')
    expect(finding?.description).toContain('(type-only)')
  })

  // One value import flips the whole edge: the aggregation is AND, per edge.
  test('an edge with any value import is not marked', () => {
    const finding = boundaryFinding(result.findings, 'missing-relationship', 'fixture.mixed')
    expect(finding?.severity).toBe('error')
    expect(finding?.description).not.toContain('(type-only)')
  })

  test('a type-only crossing still exercises a drift edge', () => {
    const finding = result.findings.find((item) => item.ruleId === 'drift-relationship')
    expect(finding?.description).toContain('1 dependency still rides')
    expect(result.findings.find((item) => item.ruleId === 'unused-drift')).toBeUndefined()
  })
})

describe("the 'info' policy", () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('type-only', {
      validate: [architectureRules({ typeOnlyImports: 'info' })],
    })
  })

  test('boundary findings on purely type-only edges drop to info', () => {
    const missing = boundaryFinding(result.findings, 'missing-relationship', 'fixture.interface')
    expect(missing?.severity).toBe('info')
    expect(missing?.description).toContain('(type-only)')

    const direction = boundaryFinding(
      result.findings,
      'relationship-direction',
      'fixture.reversed',
    )
    expect(direction?.severity).toBe('info')
    expect(direction?.description).toContain('(type-only)')
  })

  test('a value edge keeps its error severity', () => {
    const finding = boundaryFinding(result.findings, 'missing-relationship', 'fixture.mixed')
    expect(finding?.severity).toBe('error')
  })

  test('a type-only crossing still exercises a drift edge', () => {
    expect(result.findings.find((item) => item.ruleId === 'drift-relationship')).toBeDefined()
    expect(result.findings.find((item) => item.ruleId === 'unused-drift')).toBeUndefined()
  })
})

describe("the 'ignore' policy", () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('type-only', {
      validate: [architectureRules({ typeOnlyImports: 'ignore' })],
    })
  })

  test('boundary findings on purely type-only edges are dropped', () => {
    expect(
      boundaryFinding(result.findings, 'missing-relationship', 'fixture.interface'),
    ).toBeUndefined()
    expect(
      boundaryFinding(result.findings, 'relationship-direction', 'fixture.reversed'),
    ).toBeUndefined()
  })

  test('a value edge is still reported', () => {
    const finding = boundaryFinding(result.findings, 'missing-relationship', 'fixture.mixed')
    expect(finding?.severity).toBe('error')
  })

  // Ignored means not counted anywhere: a drift edge kept alive only by type
  // imports must surface as unused, or ignoring would quietly preserve debt.
  test('a type-only crossing no longer exercises a drift edge', () => {
    expect(result.findings.find((item) => item.ruleId === 'drift-relationship')).toBeUndefined()
    const unused = result.findings.find((item) => item.ruleId === 'unused-drift')
    expect(unused?.subject?.id).toBe('fixture.legacy::_::fixture.core')
  })
})
