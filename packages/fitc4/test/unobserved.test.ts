import { describe, expect, test } from 'vitest'

import { architectureRules } from '../src/providers/architecture-rules.ts'
import { exitCodeFor } from '../src/report.ts'
import { findingFor, ruleIds, runFixture } from './helpers.ts'

// An element with no `sources` is legal, but silently unenforced — which is
// indistinguishable from a typo'd model. One info finding makes the state
// chosen instead of accidental, without turning documentation into noise.
describe('unobserved elements', () => {
  test('leaf elements with neither sources nor packages become one info finding', async () => {
    const { findings } = await runFixture('unobserved')

    expect(ruleIds(findings)).toEqual(['unobserved-elements'])
    const finding = findingFor(findings, 'unobserved-elements')
    expect(finding?.severity).toBe('info')
    expect(finding?.description).toContain('12 element(s)')
    expect(finding?.description).toContain('ghost01')
    expect(finding?.description).toContain('ghost10')
  })

  test('the listed ids are capped, the count is not', async () => {
    const { findings } = await runFixture('unobserved')

    const finding = findingFor(findings, 'unobserved-elements')
    expect(finding?.description).toContain('+2 more')
    expect(finding?.description).not.toContain('ghost11')
    expect(finding?.related).toHaveLength(10)
  })

  // A parent whose children carry the claims is structural, not unobserved.
  test('parents of owned children are not listed', async () => {
    const { findings } = await runFixture('unobserved')

    const finding = findingFor(findings, 'unobserved-elements')
    expect(finding?.description).not.toContain('fixture')
  })

  test('a model whose leaves are all owned emits nothing', async () => {
    const { findings } = await runFixture('ok')

    expect(findingFor(findings, 'unobserved-elements')).toBeUndefined()
  })

  // Claiming a package is observation too: a pure-infrastructure element with
  // `packages` but no `sources` is enforced, not unobserved.
  test('a packages claim counts as observed', async () => {
    const { findings } = await runFixture('packages')

    expect(findingFor(findings, 'unobserved-elements')).toBeUndefined()
  })

  test('advisory by default, promotable to a gate failure', async () => {
    expect(exitCodeFor(await runFixture('unobserved'))).toBe(0)

    const promoted = await runFixture('unobserved', {
      validate: [architectureRules({ severity: { 'unobserved-elements': 'error' } })],
    })
    expect(exitCodeFor(promoted)).toBe(1)
  })
})
