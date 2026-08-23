/**
 * Rule severity tuning lives on the provider: `architectureRules({ severity })`
 * in the config's own validate array. The map is validated at construction,
 * because a typo'd promotion that silently does nothing is a team believing
 * their gate is closed when it is open — and TypeScript only catches the typo
 * in a project that typechecks its config.
 */

import { describe, expect, test } from 'vitest'

import { architectureRules } from '../src/providers/architecture-rules.ts'
import { runFixture } from './helpers.ts'

const HEAVY = { timeout: 120_000 }

describe('validating the severity map', () => {
  test('an unknown rule id is an error, suggesting the near miss', () => {
    expect(() => architectureRules({ severity: { 'unmaped-source': 'error' } } as never)).toThrow(
      /unknown rule 'unmaped-source', did you mean 'unmapped-source'\?/,
    )
    expect(() =>
      architectureRules({ severity: { 'totally-made-up': 'error' } } as never),
    ).toThrow(/unknown rule 'totally-made-up'/)
    // No suggestion when nothing is close, rather than a misleading one.
    expect(() =>
      architectureRules({ severity: { 'totally-made-up': 'error' } } as never),
    ).not.toThrow(/did you mean/)
    // And the reader is pointed at the rule reference.
    expect(() =>
      architectureRules({ severity: { 'totally-made-up': 'error' } } as never),
    ).toThrow(/README\.md#rules/)
  })

  test.each([
    ['an unknown level', { 'unmapped-source': 'fatal' }],
    ['a non-string level', { 'unmapped-source': 2 }],
    ['a null level', { 'unmapped-source': null }],
  ])('%s is an error', (_label, severity) => {
    expect(() => architectureRules({ severity: severity as never })).toThrow(
      /must be one of error, warning, info/,
    )
  })
})

describe('applying the severity map', () => {
  // The standard severities assume adoption: unowned code is a warning nudge.
  // The map is how a team done adopting closes that door.
  test('promotes unmapped-source from warning to error', HEAVY, async () => {
    const relaxed = await runFixture('violations')
    const promoted = await runFixture('violations', {
      validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })],
    })

    const severityOf = (result: Awaited<ReturnType<typeof runFixture>>): string[] =>
      result.findings
        .filter((finding) => finding.ruleId === 'unmapped-source')
        .map((finding) => finding.severity)

    expect(severityOf(relaxed)).not.toHaveLength(0)
    expect(new Set(severityOf(relaxed))).toEqual(new Set(['warning']))
    expect(new Set(severityOf(promoted))).toEqual(new Set(['error']))
  })
})
