/**
 * Ref-vocabulary tests: the words an agent uses for conceptual components.
 *
 * An agent describing a compose service writes `{ kind: 'service', id: ... }`
 * because that is what the thing is; two independent models did exactly this
 * the first time either ran with near-zero instructions, and the pipeline
 * dropped both replies without a finding. Under test is the repair, end to
 * end on the `fragments` fixture: `source-root` owning a ref by its id alone
 * — as a claimed path or fragment, or as an element name, exact or
 * spelling-insensitive — regardless of the kind the scanner chose, and the
 * `unmapped-reference` warning that replaces silence when no vocabulary maps.
 * No real agent CLI is ever invoked; the exec is an in-process stub.
 */

import { describe, expect, test } from 'vitest'

import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import { agentScan } from '../src/agent/scan.ts'
import type { PipelineResult } from '../src/pipeline.ts'
import { findingFor, runFixture } from './helpers.ts'

const COMPOSE = 'stack/compose.yml'

function stubExec(reply: AgentReply): AgentExec {
  return {
    id: 'stub/model',
    async run(_request: AgentRequest): Promise<AgentReply> {
      return reply
    },
  }
}

function ok(value: unknown): AgentReply {
  return { ok: true, value: value as never, raw: JSON.stringify(value) }
}

/** A dependency in whatever vocabulary the test wants to speak. */
function edge(subject: { kind: string; id: string }, target: { kind: string; id: string }) {
  return {
    kind: 'dependency',
    subject,
    target,
    description: `${subject.id} depends on ${target.id}`,
    evidence: [{ path: COMPOSE, line: 1 }],
  }
}

function run(observations: unknown[]): Promise<PipelineResult> {
  return runFixture('fragments', {
    scan: [
      agentScan({
        exec: stubExec(ok({ observations, examined: [COMPOSE] })),
        instructions: 'report each depends_on entry between the compose services',
        roots: ['stack'],
      }),
    ],
  })
}

describe('service-kind refs carrying claimed locators', () => {
  test('a declared edge resolves through the fragment claim, whatever the kind says', async () => {
    const result = await run([
      edge(
        { kind: 'service', id: `${COMPOSE}#services.web` },
        { kind: 'service', id: `${COMPOSE}#services.api` },
      ),
      edge(
        { kind: 'service', id: `${COMPOSE}#services.api` },
        { kind: 'service', id: `${COMPOSE}#services.db` },
      ),
    ])

    const resolved = result.associations.filter((item) => item.status === 'resolved')
    expect(resolved.map((item) => `${item.source?.id}->${item.target?.id}`).sort()).toEqual([
      'fixture.api->fixture.db',
      'fixture.web->fixture.api',
    ])
    expect(result.findings.filter((finding) => finding.severity !== 'info')).toEqual([])
  })
})

describe('refs naming model elements', () => {
  test('declared edges between element names resolve and pass', async () => {
    const result = await run([
      edge({ kind: 'service', id: 'web' }, { kind: 'service', id: 'api' }),
      edge({ kind: 'service', id: 'api' }, { kind: 'service', id: 'db' }),
    ])

    const resolved = result.associations.filter((item) => item.status === 'resolved')
    expect(resolved.map((item) => `${item.source?.id}->${item.target?.id}`).sort()).toEqual([
      'fixture.api->fixture.db',
      'fixture.web->fixture.api',
    ])
    expect(result.findings.filter((finding) => finding.severity !== 'info')).toEqual([])
  })

  test('an element the scan never speaks of keeps its unmatched-sources tripwire', async () => {
    // Only web -> api: db's fragment claim sits untouched inside an examined
    // file, unreached by any vocabulary, which is exactly the typo'd-locator
    // state the fail-closed rule exists to catch.
    const result = await run([edge({ kind: 'service', id: 'web' }, { kind: 'service', id: 'api' })])

    const finding = findingFor(result.findings, 'unmatched-sources')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.db')
  })

  test('an undeclared edge between element names is judged, not just accepted', async () => {
    const result = await run([edge({ kind: 'service', id: 'web' }, { kind: 'service', id: 'db' })])

    const finding = findingFor(result.findings, 'missing-relationship')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.web')
    expect(finding?.related?.[0]?.id).toBe('fixture.db')
  })

  test('spelling differences resolve through normalization, full ids verbatim', async () => {
    const result = await run([
      // 'Web' for the leaf 'web', and the full LikeC4 id for the target.
      edge({ kind: 'service', id: 'Web' }, { kind: 'service', id: 'fixture.api' }),
    ])

    const resolved = result.associations.filter((item) => item.status === 'resolved')
    expect(resolved.map((item) => `${item.source?.id}->${item.target?.id}`)).toEqual([
      'fixture.web->fixture.api',
    ])
  })

  test('a module target never resolves by element name', async () => {
    // 'db' names an element, but a module ref is a package specifier, and a
    // package spelled like an element is a coincidence, not an address.
    const result = await run([edge({ kind: 'service', id: 'web' }, { kind: 'module', id: 'db' })])

    expect(result.associations.filter((item) => item.status === 'resolved')).toEqual([])
    expect(findingFor(result.findings, 'missing-relationship')).toBeUndefined()
  })
})

describe('vocabulary that maps onto nothing', () => {
  test('warns instead of dropping the edge silently', async () => {
    const result = await run([
      edge({ kind: 'service', id: 'web' }, { kind: 'service', id: 'cache' }),
    ])

    const finding = findingFor(result.findings, 'unmapped-reference')
    expect(finding?.severity).toBe('warning')
    expect(finding?.subject?.id).toBe('web')
    expect(finding?.description).toContain('cannot be checked')
  })

  test('is promotable to a gate failure like any other rule', async () => {
    const { architectureRules } = await import('../src/index.ts')
    const result = await runFixture('fragments', {
      scan: [
        agentScan({
          exec: stubExec(
            ok({
              observations: [edge({ kind: 'service', id: 'web' }, { kind: 'service', id: 'cache' })],
              examined: [COMPOSE],
            }),
          ),
          instructions: 'report each depends_on entry between the compose services',
          roots: ['stack'],
        }),
      ],
      validate: [architectureRules({ severity: { 'unmapped-reference': 'error' } })],
    })

    expect(findingFor(result.findings, 'unmapped-reference')?.severity).toBe('error')
  })
})
