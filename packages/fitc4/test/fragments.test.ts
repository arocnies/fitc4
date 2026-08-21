/**
 * Fragment-claim tests: sub-file ownership end to end.
 *
 * The `fragments` fixture puts three services in one compose file, each
 * element claiming its region with a `sources '<path>#<fragment>'` locator.
 * Under test is the whole path a fragment takes through the pipeline: the
 * scan-side hallucination guard on the path part, `source-root` resolution by
 * longest claim, the standard relationship rules judging fragment edges like
 * any other crossing, and the fragment side of the `unmatched-sources`
 * fail-closed family. No real agent CLI is ever invoked; the exec is an
 * in-process stub.
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

function fragmentDependency(from: string, to: string, line: number) {
  return {
    kind: 'dependency',
    subject: { kind: 'file', id: `${COMPOSE}#services.${from}` },
    target: { kind: 'file', id: `${COMPOSE}#services.${to}` },
    description: `${from} depends on ${to}`,
    evidence: [{ path: COMPOSE, line }],
  }
}

function run(reply: AgentReply): Promise<PipelineResult> {
  return runFixture('fragments', {
    scan: [
      agentScan({
        exec: stubExec(reply),
        instructions: 'report each depends_on entry between the compose services',
        roots: ['stack'],
      }),
    ],
  })
}

describe('fragment claims end to end', () => {
  test('declared fragment edges resolve onto the claiming elements and pass', async () => {
    const result = await run(
      ok({
        observations: [fragmentDependency('web', 'api', 5), fragmentDependency('api', 'db', 9)],
        examined: [COMPOSE],
      }),
    )

    const edge = result.associations.find(
      (item) => item.source?.id === 'fixture.web' && item.target?.id === 'fixture.api',
    )
    expect(edge?.status).toBe('resolved')
    expect(edge?.relationship?.id).toBe('fixture.web::_::fixture.api')

    expect(findingFor(result.findings, 'provider-failure')).toBeUndefined()
    expect(findingFor(result.findings, 'missing-relationship')).toBeUndefined()
    expect(findingFor(result.findings, 'unmatched-sources')).toBeUndefined()
    // Every element owns a fragment, so none is unobserved.
    expect(findingFor(result.findings, 'unobserved-elements')).toBeUndefined()
  })

  test('an undeclared fragment edge is a missing-relationship error', async () => {
    const result = await run(
      ok({
        observations: [
          fragmentDependency('web', 'api', 5),
          fragmentDependency('api', 'db', 9),
          fragmentDependency('web', 'db', 5),
        ],
        examined: [COMPOSE],
      }),
    )

    const missing = findingFor(result.findings, 'missing-relationship')
    expect(missing?.severity).toBe('error')
    expect(missing?.subject).toEqual({ kind: 'element', id: 'fixture.web' })
    expect(missing?.related).toContainEqual({ kind: 'element', id: 'fixture.db' })
  })

  // The fragment side of the fail-closed family: a locator nothing in the
  // examined file matches would otherwise silently gate nothing.
  test('a fragment claim no observation touches in an examined file is unmatched-sources', async () => {
    const result = await run(
      ok({
        observations: [fragmentDependency('web', 'api', 5)],
        examined: [COMPOSE],
      }),
    )

    const unmatched = findingFor(result.findings, 'unmatched-sources')
    expect(unmatched?.severity).toBe('error')
    expect(unmatched?.subject).toEqual({ kind: 'element', id: 'fixture.db' })
    expect(unmatched?.description).toContain('stack/compose.yml#services.db')
  })

  // A fragment inside a file the scan never examined is outside the scan,
  // the same legal state as a directory outside the scan roots.
  test('fragment claims in an unexamined file are not reported as unmatched', async () => {
    const result = await run(
      ok({
        observations: [],
        examined: ['stack/README.md'],
      }),
    )

    expect(findingFor(result.findings, 'unmatched-sources')).toBeUndefined()
  })

  test('a fragment ref whose file part does not exist fails the provider', async () => {
    const result = await run(
      ok({
        observations: [
          {
            kind: 'dependency',
            subject: { kind: 'file', id: 'stack/missing.yml#services.web' },
            target: { kind: 'file', id: `${COMPOSE}#services.api` },
          },
        ],
        examined: [COMPOSE],
      }),
    )

    const failure = findingFor(result.findings, 'provider-failure')
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('stack/missing.yml')
  })
})
