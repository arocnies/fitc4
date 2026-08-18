/**
 * Provider tests inject a stub `AgentExec` and run the real pipeline over the
 * fixture repositories, so what is under test is everything except the model:
 * unowned-file discovery, prompt and context assembly, reply shape-checking,
 * hallucination guards, severity capping, and the unavailable/truncated paths.
 */

import { describe, expect, test } from 'vitest'

import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import { agentOwnershipAdvisor, PROVIDER_ID as ADVISOR_ID } from '../src/agent/ownership-advisor.ts'
import { agentSemanticReview, PROVIDER_ID as REVIEW_ID } from '../src/agent/semantic-review.ts'
import { renderReport } from '../src/report.ts'
import { findingFor, ruleIds, runFixture } from './helpers.ts'

function stubExec(replies: AgentReply[]): AgentExec & { requests: AgentRequest[] } {
  const exec = {
    id: 'stub/model',
    requests: [] as AgentRequest[],
    async run(request: AgentRequest): Promise<AgentReply> {
      exec.requests.push(request)
      const reply = replies[Math.min(exec.requests.length, replies.length) - 1]
      if (reply === undefined) throw new Error('stub exhausted')
      return reply
    },
  }
  return exec
}

function ok(value: unknown): AgentReply {
  return { ok: true, value: value as never, raw: JSON.stringify(value) }
}

describe('agentOwnershipAdvisor', () => {
  test('suggests an owner for the unowned file, from a prefilled catalog and excerpt', async () => {
    const exec = stubExec([
      ok({
        files: [
          { path: 'src/orphan/thing.ts', element: 'fixture.app.core', rationale: 'core logic' },
          // Not asked about — must be dropped, not become a finding.
          { path: 'src/invented.ts', element: 'fixture.app.core', rationale: 'hallucinated' },
          // Second answer for an already-answered path — must be dropped.
          { path: 'src/orphan/thing.ts', element: 'fixture.app.extra', rationale: 'duplicate' },
        ],
      }),
    ])

    const result = await runFixture('violations', { validate: [agentOwnershipAdvisor({ exec })] })

    expect(ruleIds(result.findings)).toEqual(['ownership-suggestion'])
    const finding = findingFor(result.findings, 'ownership-suggestion')
    expect(finding?.severity).toBe('info')
    expect(finding?.subject).toEqual({ kind: 'file', id: 'src/orphan/thing.ts' })
    expect(finding?.related).toEqual([{ kind: 'element', id: 'fixture.app.core' }])
    expect(finding?.description).toContain('may belong to fixture.app.core')

    const request = exec.requests[0]
    expect(request?.context).toContain('Elements in the architecture model')
    expect(request?.context).toContain('fixture.app.core')
    expect(request?.context).toContain('### src/orphan/thing.ts')
    expect(request?.schema).toBeDefined()
  })

  test('a suggestion naming a non-existent element is reported as exactly that', async () => {
    const exec = stubExec([
      ok({ files: [{ path: 'src/orphan/thing.ts', element: 'fixture.app.nope', rationale: 'guess' }] }),
    ])

    const result = await runFixture('violations', { validate: [agentOwnershipAdvisor({ exec })] })

    const finding = findingFor(result.findings, 'ownership-suggestion')
    expect(finding?.description).toContain("not in the model")
    expect(finding?.related).toBeUndefined()
  })

  test('a null element reads as a missing-element hint', async () => {
    const exec = stubExec([
      ok({ files: [{ path: 'src/orphan/thing.ts', element: null, rationale: 'nothing fits' }] }),
    ])

    const result = await runFixture('violations', { validate: [agentOwnershipAdvisor({ exec })] })

    expect(findingFor(result.findings, 'ownership-suggestion')?.description).toContain(
      'fits no existing element',
    )
  })

  test('an unavailable exec behind an advisory provider is a warning, not a failed build', async () => {
    const exec = stubExec([{ ok: false, error: 'not logged in' }])

    const result = await runFixture('violations', { validate: [agentOwnershipAdvisor({ exec })] })

    const finding = findingFor(result.findings, 'agent-unavailable')
    expect(finding?.severity).toBe('warning')
    expect(finding?.description).toContain('not logged in')
    expect(renderReport(result).exitCode).toBe(0)
  })

  test("severity: 'error' makes the provider gate, and its absence fails the build", async () => {
    const exec = stubExec([{ ok: false, error: 'down' }])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec, severity: 'error' })],
    })

    // A gating provider whose CLI is down is a hole in the gate, not a nudge.
    expect(findingFor(result.findings, 'agent-unavailable')?.severity).toBe('error')
  })

  test("severity: 'error' escalates truncation too — unjudged inputs bypassed the gate", async () => {
    const exec = stubExec([])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec, severity: 'error', maxFiles: 0 })],
    })

    expect(findingFor(result.findings, 'agent-truncated')?.severity).toBe('error')
  })

  test("severity: 'error' fails the build when the reply omits asked files", async () => {
    const exec = stubExec([ok({ files: [] })])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec, severity: 'error' })],
    })

    // A file the judge never ruled on is a file that bypassed the gate.
    const finding = findingFor(result.findings, 'agent-unavailable')
    expect(finding?.severity).toBe('error')
    expect(finding?.description).toContain('omitted 1 of 1')
  })

  test('an advisory run shrugs off a lazy reply — unmapped-source still stands', async () => {
    const exec = stubExec([ok({ files: [] })])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec })],
    })

    expect(findingFor(result.findings, 'agent-unavailable')).toBeUndefined()
  })

  test('a chosen severity is what suggestions report at', async () => {
    const exec = stubExec([
      ok({ files: [{ path: 'src/orphan/thing.ts', element: 'fixture.app.core', rationale: 'r' }] }),
    ])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec, severity: 'warning' })],
    })

    expect(findingFor(result.findings, 'ownership-suggestion')?.severity).toBe('warning')
  })

  test('files beyond maxFiles are reported, and zero budget means zero calls', async () => {
    const exec = stubExec([])

    const result = await runFixture('violations', {
      validate: [agentOwnershipAdvisor({ exec, maxFiles: 0 })],
    })

    expect(exec.requests).toHaveLength(0)
    expect(findingFor(result.findings, 'agent-truncated')?.description).toContain('1 unowned files')
  })

  test('a clean repository costs zero agent calls', async () => {
    const exec = stubExec([])

    const result = await runFixture('ok', {
      validate: [agentOwnershipAdvisor({ exec })],
    })

    expect(exec.requests).toHaveLength(0)
    expect(result.findings).toEqual([])
  })
})

describe('agentSemanticReview', () => {
  test('a mismatch verdict becomes a capped drift finding with the issues as evidence', async () => {
    // Elements are reviewed in id order: demo.core mismatches, demo.extra matches.
    const exec = stubExec([
      ok({ matches: false, issues: ['performs file I/O in add()'] }),
      ok({ matches: true, issues: [] }),
    ])

    const result = await runFixture('described', { validate: [agentSemanticReview({ exec })] })

    expect(result.findings).toHaveLength(1)
    expect(ruleIds(result.findings)).toEqual(['description-drift'])
    const finding = findingFor(result.findings, 'description-drift')
    expect(finding?.severity).toBe('warning')
    expect(finding?.subject).toEqual({ kind: 'element', id: 'demo.core' })
    expect(finding?.description).toContain('performs file I/O in add()')
    expect(finding?.evidence).toEqual([{ detail: 'performs file I/O in add()' }])

    const request = exec.requests[0]
    expect(request?.prompt).toContain('Pure calculation; performs no I/O')
    expect(request?.context).toContain('### src/core/calc.ts')
  })

  test('a matching verdict is silence', async () => {
    const exec = stubExec([ok({ matches: true, issues: [] })])

    const result = await runFixture('described', { validate: [agentSemanticReview({ exec })] })

    expect(result.findings).toEqual([])
  })

  test('elements without descriptions cost zero agent calls', async () => {
    const exec = stubExec([])

    const result = await runFixture('violations', { validate: [agentSemanticReview({ exec })] })

    expect(exec.requests).toHaveLength(0)
    expect(result.findings).toEqual([])
  })

  // The fixture has two described elements on purpose: without the second,
  // this passes even if the provider keeps calling a dead CLI per element.
  test('the first exec failure stops the run with one finding', async () => {
    const exec = stubExec([{ ok: false, error: 'CLI missing' }])

    const result = await runFixture('described', { validate: [agentSemanticReview({ exec })] })

    expect(exec.requests).toHaveLength(1)
    expect(result.findings).toHaveLength(1)
    expect(ruleIds(result.findings)).toEqual(['agent-unavailable'])
    expect(findingFor(result.findings, 'agent-unavailable')?.severity).toBe('warning')
  })
})

// The provider ids double as finding-id namespaces; a rename would churn every
// consumer's baseline, so they are pinned.
test('provider ids are stable', () => {
  expect(ADVISOR_ID).toBe('agent-ownership-advisor')
  expect(REVIEW_ID).toBe('agent-semantic-review')
})

describe('provider composition visibility', () => {
  test('the result and report name who judged the run', async () => {
    const exec = stubExec([ok({ files: [] })])

    const result = await runFixture('violations', { validate: [agentOwnershipAdvisor({ exec })] })

    expect(result.providers).toEqual({
      scan: ['typescript-imports'],
      resolve: ['source-root'],
      validate: ['agent-ownership-advisor'],
    })
    // The report shows a replaced phase — this run has no architecture-rules,
    // and the line says so.
    expect(renderReport(result).text).toContain(
      'scan typescript-imports · resolve source-root · validate agent-ownership-advisor',
    )
  })
})
