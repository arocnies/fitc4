/**
 * The `circular-dependency` rule: exercised cycles made entirely of declared
 * edges, the one dependency defect every per-edge rule passes quietly.
 *
 * The `cycle` fixture declares a <-> b (both directions) plus a -> c, and the
 * code exercises all three edges, so a and b form a declared, exercised
 * two-cycle while c stays acyclic. The pure-function tests pin the graph
 * behavior integration cannot reach cheaply: chains staying silent, tangles
 * collapsing to one finding per component, and separate cycles staying
 * separate findings.
 */

import { describe, expect, test } from 'vitest'

import { circularDependencyRules } from '../src/providers/architecture-rules/cycles.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import type { Severity } from '../src/types.ts'
import { findingFor, runFixture } from './helpers.ts'

const asDefault = (_rule: string, standard: Severity): Severity => standard

describe('circularDependencyRules', () => {
  test('a chain produces nothing', () => {
    const findings = circularDependencyRules(
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
      asDefault,
    )
    expect(findings).toEqual([])
  })

  test('a tangle is one finding per component, not per elementary cycle', () => {
    const findings = circularDependencyRules(
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'a' },
        { source: 'b', target: 'a' },
      ],
      asDefault,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.related?.map((ref) => ref.id).sort()).toEqual(['a', 'b', 'c'])
  })

  test('two separate cycles are two findings with stable witnesses', () => {
    const findings = circularDependencyRules(
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
        { source: 'x', target: 'y' },
        { source: 'y', target: 'x' },
      ],
      asDefault,
    )
    expect(findings).toHaveLength(2)
    const descriptions = findings.map((finding) => finding.description).sort()
    expect(descriptions[0]).toContain('a -> b -> a')
    expect(descriptions[1]).toContain('x -> y -> x')
  })

  test('self-loops never count', () => {
    expect(circularDependencyRules([{ source: 'a', target: 'a' }], asDefault)).toEqual([])
  })
})

describe('through the pipeline', () => {
  test('an exercised, fully declared cycle is one warning naming its members', async () => {
    const result = await runFixture('cycle')
    const finding = findingFor(result.findings, 'circular-dependency')
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('warning')
    expect(finding?.related?.map((ref) => ref.id).sort()).toEqual(['fixture.a', 'fixture.b'])
    expect(finding?.description).toContain('fixture.a -> fixture.b -> fixture.a')
    // The acyclic a -> c edge stays out of it, and nothing else fires.
    expect(finding?.related?.map((ref) => ref.id)).not.toContain('fixture.c')
    expect(result.findings.filter((entry) => entry.ruleId !== 'circular-dependency')).toEqual([])
  })

  test('the rule promotes to error through the standard severity option', async () => {
    const result = await runFixture('cycle', {
      validate: [architectureRules({ severity: { 'circular-dependency': 'error' } })],
    })
    expect(findingFor(result.findings, 'circular-dependency')?.severity).toBe('error')
  })
})
