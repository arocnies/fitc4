/**
 * The eval scorer itself, under test: `evals/harness/score.ts` decides every
 * number the eval suite reports, so its own failure modes are pinned here.
 * Each test is one illusion the scorer must not permit: a padded agent reply
 * passing quietly, a provider passing by never being wired, a citation whose
 * line says something else, a floor row failing a run it must never fail.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  perfect,
  renderScorecard,
  scoreFixture,
  type Expectations,
} from '../../../evals/harness/score.ts'
import type { PipelineResult } from '../src/pipeline.ts'
import type { Observation } from '../src/types.ts'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function repositoryWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-score-'))
  tempDirs.push(dir)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(dir, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return dir
}

function observation(overrides: Partial<Observation> & { provider: string; kind: string }): Observation {
  return { id: `${overrides.provider}:${overrides.kind}:${overrides.subject?.id ?? '?'}`, ...overrides }
}

function resultWith(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    modelErrors: [],
    providers: { scan: [], resolve: [], validate: [] },
    observations: [],
    associations: [],
    findings: [],
    ...overrides,
  }
}

const NO_EXPECTATIONS: Expectations = { findings: [] }

describe('unclaimed observations', () => {
  const chatty = resultWith({
    observations: [
      observation({ provider: 'agent-scan', kind: 'dependency', subject: { kind: 'file', id: 'a' } }),
    ],
  })

  it('counts an unclaimed agent observation as an extra', () => {
    const score = scoreFixture('fixture', NO_EXPECTATIONS, chatty)
    expect(perfect(score)).toBe(false)
    const row = score.providers.find((entry) => entry.provider === 'agent-scan')
    expect(row?.extras).toBe(1)
    expect(row?.notes[0]).toContain('unexpected observation')
  })

  it('tolerates unclaimed agent observations only under openEnded', () => {
    const expectations: Expectations = { findings: [], observations: { openEnded: true } }
    expect(perfect(scoreFixture('fixture', expectations, chatty))).toBe(true)
  })

  it('tolerates deterministic providers enumerating unpinned files', () => {
    const deterministic = resultWith({
      observations: [
        observation({ provider: 'import-scan', kind: 'file', subject: { kind: 'file', id: 'a' } }),
      ],
    })
    expect(perfect(scoreFixture('fixture', NO_EXPECTATIONS, deterministic))).toBe(true)
  })
})

describe('provider roster', () => {
  const expectations: Expectations = { findings: [], providersMust: ['agent-resolve'] }

  it('fails a row whose pinned provider was never wired', () => {
    const score = scoreFixture('fixture', expectations, resultWith())
    expect(perfect(score)).toBe(false)
    const row = score.providers.find((entry) => entry.provider === 'agent-resolve')
    expect(row?.misses).toBe(1)
    expect(row?.notes[0]).toContain('not wired')
  })

  it('passes when the provider is wired, even producing nothing', () => {
    const wired = resultWith({ providers: { scan: [], resolve: ['agent-resolve'], validate: [] } })
    expect(perfect(scoreFixture('fixture', expectations, wired))).toBe(true)
  })
})

describe('evidence checking', () => {
  const repositoryRoot = repositoryWith({
    'compose.yml': 'services:\n  web:\n    depends_on:\n      - db\n',
  })
  const cited = resultWith({
    observations: [
      observation({
        provider: 'agent-scan',
        kind: 'dependency',
        subject: { kind: 'file', id: 'web' },
        evidence: [{ path: 'compose.yml', line: 4 }],
      }),
    ],
  })
  const expecting = (lineIncludes: string): Expectations => ({
    findings: [],
    observations: {
      must: [
        {
          provider: 'agent-scan',
          kind: 'dependency',
          subject: 'web',
          evidence: { path: 'compose.yml', lineIncludes },
        },
      ],
    },
  })

  it('passes when the cited line contains the pinned text', () => {
    const score = scoreFixture('fixture', expecting('- db'), cited, { repositoryRoot })
    expect(perfect(score)).toBe(true)
  })

  it('fails when the cited line says something else', () => {
    const score = scoreFixture('fixture', expecting('- api'), cited, { repositoryRoot })
    expect(perfect(score)).toBe(false)
    const row = score.providers.find((entry) => entry.provider === 'agent-scan')
    expect(row?.notes.some((note) => note.includes('evidence check failed'))).toBe(true)
  })

  it('fails when the observation cites no such file', () => {
    const uncited = resultWith({
      observations: [
        observation({ provider: 'agent-scan', kind: 'dependency', subject: { kind: 'file', id: 'web' } }),
      ],
    })
    const score = scoreFixture('fixture', expecting('- db'), uncited, { repositoryRoot })
    expect(perfect(score)).toBe(false)
  })

  it('fails loudly when the scorer got no repositoryRoot', () => {
    const score = scoreFixture('fixture', expecting('- db'), cited)
    expect(perfect(score)).toBe(false)
    const row = score.providers.find((entry) => entry.provider === 'agent-scan')
    expect(row?.notes.some((note) => note.includes('repositoryRoot'))).toBe(true)
  })
})

describe('floors', () => {
  it('marks a gate:false row as a floor and renders its drift without FAIL', () => {
    const expectations: Expectations = {
      findings: [{ provider: 'architecture-rules', ruleId: 'unmapped-source' }],
      gate: false,
    }
    const score = scoreFixture('fixture', expectations, resultWith())
    expect(score.floor).toBe(true)
    expect(perfect(score)).toBe(false)
    const rendered = renderScorecard([score])
    expect(rendered).toContain('floor(drift)')
    expect(rendered).not.toContain('FAIL')
  })

  it('renders a matching floor row as floor, not ok', () => {
    const expectations: Expectations = { findings: [], gate: false }
    const rendered = renderScorecard([scoreFixture('fixture', expectations, resultWith())])
    expect(rendered).toContain('floor')
    expect(rendered).not.toContain('floor(drift)')
  })
})

describe('finding matching', () => {
  it('scores a wrong-severity finding as a miss plus an extra', () => {
    const expectations: Expectations = {
      findings: [{ provider: 'architecture-rules', ruleId: 'missing-relationship', severity: 'error' }],
    }
    const downgraded = resultWith({
      findings: [
        {
          id: 'f1',
          provider: 'architecture-rules',
          ruleId: 'missing-relationship',
          severity: 'warning',
          description: 'edge without a declared relationship',
        },
      ],
    })
    const score = scoreFixture('fixture', expectations, downgraded)
    const row = score.providers.find((entry) => entry.provider === 'architecture-rules')
    expect(row?.misses).toBe(1)
    expect(row?.extras).toBe(1)
  })
})
