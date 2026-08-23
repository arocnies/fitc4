/**
 * The opt-in missing-descriptions rule: one info finding per undescribed
 * element, so a team that wants the documentation burn-down can count it.
 * Opt-in because a description is documentation, not structure, so the
 * scaffolded config never lists it; a team that wants it adds it to
 * `validate` alongside `architectureRules()`.
 */

import { describe, expect, test } from 'vitest'

import { missingDescriptions, PROVIDER_ID } from '../src/providers/missing-descriptions.ts'
import { runFixture } from './helpers.ts'

const HEAVY = { timeout: 120_000 }

describe('missingDescriptions', () => {
  test('absent, empty, and TODO descriptions are each one info finding; described elements are silence', HEAVY, async () => {
    const result = await runFixture('todo-descriptions', { validate: [missingDescriptions()] })

    expect(result.findings.every((finding) => finding.severity === 'info')).toBe(true)
    expect(result.findings.every((finding) => finding.ruleId === 'missing-description')).toBe(true)
    expect(result.findings.every((finding) => finding.provider === PROVIDER_ID)).toBe(true)

    const byElement = new Map(
      result.findings.map((finding) => [finding.subject?.id, finding.description]),
    )
    // The wrapping system counts too: the rule is per element, not per leaf.
    expect(byElement.get('demo')).toContain('has no description')
    expect(byElement.get('demo.silent')).toContain('has no description')
    // LikeC4 normalizes a whitespace-only description away before the rule
    // ever sees it, so 'blank' lands on the absent branch.
    expect(byElement.get('demo.blank')).toContain('has no description')
    expect(byElement.get('demo.todo')).toContain('still carries a TODO description')
    expect(byElement.has('demo.described')).toBe(false)
    expect(result.findings).toHaveLength(4)
  })

  // LikeC4's own parser never yields an empty string, but a description can
  // arrive as a `{ txt }` wrapper from other authoring forms, so the empty
  // branch is pinned against a structural stand-in for the model.
  test('an empty description that does reach the rule is named as empty', async () => {
    const model = {
      elements: () => [{ id: 'stub.blank', description: { txt: '' } }],
    }
    const provider = missingDescriptions()
    const findings = await provider.run({
      model: model as never,
      observations: [],
      associations: [],
      repositoryRoot: '.',
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.description).toBe('stub.blank has an empty description.')
  })

  test('described leaves are silence; only the undescribed container reports', HEAVY, async () => {
    // The described fixture's two components carry real descriptions; the
    // wrapping system does not, so it is the only finding.
    const result = await runFixture('described', { validate: [missingDescriptions()] })

    expect(result.findings.map((finding) => finding.subject?.id)).toEqual(['demo'])
  })

})
