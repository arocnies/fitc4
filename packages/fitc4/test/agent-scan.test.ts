/**
 * `agentScan` tests inject a stub `AgentExec` and run the real pipeline over the
 * fixture repositories. Under test is everything except the model: listing
 * enumeration and truncation announcement, prompt and context assembly, the
 * fail-closed contract (exec failure, off-schema reply, empty attestation,
 * hallucinated paths all become one provider-failure error), attestation
 * conversion, id minting, cache composition, and multi-instance coexistence.
 *
 * No real agent CLI is ever invoked: the exec is an in-process stub, and the
 * fail-closed semantics are exactly what makes that safe to rely on.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { cached } from '../src/agent/cache.ts'
import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import { agentScan, PROVIDER_ID as SCAN_ID } from '../src/agent/scan.ts'
import type { Finding, Observation } from '../src/types.ts'
import { findingFor, fixturePath, runFixture } from './helpers.ts'

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

/** A well-formed reply against the `violations` fixture. */
function goodReply(): AgentReply {
  return ok({
    observations: [
      {
        kind: 'file',
        subject: { kind: 'file', id: 'docs/notes.md' },
      },
      {
        kind: 'dependency',
        subject: { kind: 'file', id: 'docs/notes.md' },
        target: { kind: 'file', id: 'src/core/health.ts' },
        description: 'the notes document the core health check',
        evidence: [{ path: 'docs/notes.md', line: 1 }],
      },
      {
        kind: 'doc-link',
        subject: { kind: 'file', id: 'docs/notes.md' },
      },
    ],
    examined: ['docs/notes.md'],
  })
}

function observationIds(observations: Observation[]): string[] {
  return observations.map((observation) => observation.id)
}

function providerFailure(findings: Finding[]): Finding | undefined {
  return findingFor(findings, 'provider-failure')
}

describe('agentScan happy path', () => {
  test('observations and scan-root attestations flow through a real pipeline run', async () => {
    const exec = stubExec([goodReply()])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'read the docs and report what they claim about the code' })],
    })

    // The reply became namespaced standard observations plus one scan-root
    // attestation per examined file.
    const ids = observationIds(result.observations)
    expect(ids).toContain('agent-scan/scan-root:docs/notes.md')
    expect(ids).toContain('agent-scan/file:docs/notes.md')
    expect(ids).toContain('agent-scan/dependency:docs/notes.md->src/core/health.ts')

    const attestation = result.observations.find((o) => o.kind === 'scan-root')
    expect(attestation?.subject).toEqual({ kind: 'file', id: 'docs/notes.md' })

    // The observations fed the deterministic phases: source-root associated
    // the file observation, and the rules judged it unowned.
    expect(providerFailure(result.findings)).toBeUndefined()
    const unmapped = findingFor(result.findings, 'unmapped-source')
    expect(unmapped?.subject).toEqual({ kind: 'file', id: 'docs/notes.md' })
    expect(findingFor(result.findings, 'orphaned-association')).toBeUndefined()

    // The non-standard kind is reported at info, never rejected or dropped.
    const unknown = findingFor(result.findings, 'unknown-observation-kind')
    expect(unknown?.severity).toBe('info')
    expect(unknown?.description).toContain('doc-link')
    expect(result.observations.some((o) => o.kind === 'doc-link')).toBe(true)
  })

  test('the request is agentic and prefilled with the instructions and listing', async () => {
    const exec = stubExec([goodReply()])

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'trace doc-to-code links' })],
    })

    const request = exec.requests[0]
    expect(exec.requests).toHaveLength(1)
    expect(request?.agentic).toBe(true)
    expect(request?.schema).toBeDefined()
    expect(request?.context).toContain('trace doc-to-code links')
    expect(request?.context).toContain('- docs/notes.md')
    expect(request?.context).toContain('- src/core/health.ts')
    expect(request?.context).not.toContain('truncated')
    expect(request?.prompt).toContain('examined')
  })

  test('focus assembles a one-shot request: excerpts embedded, no agentic flag', async () => {
    const exec = stubExec([goodReply()])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'trace doc-to-code links', focus: ['docs/**'] })],
    })

    const request = exec.requests[0]
    expect(exec.requests).toHaveLength(1)
    // One-shot: the reply can only come from the prefilled context.
    expect(request?.agentic).toBeUndefined()
    expect(request?.schema).toBeDefined()
    // The pack header puts the format semantics in the cache key.
    expect(request?.context?.startsWith('context-pack v1')).toBe(true)
    expect(request?.context).toContain('trace doc-to-code links')
    // The matched file's CONTENT is embedded, not merely listed — which is
    // also what closes the agentic cache-staleness hole.
    expect(request?.context).toContain('### docs/notes.md')
    expect(request?.context).toContain('# notes')
    // Unmatched files are not excerpted.
    expect(request?.context).not.toContain('### src/core/health.ts')

    // The reply flows through the pipeline exactly as in agentic mode.
    expect(providerFailure(result.findings)).toBeUndefined()
    expect(observationIds(result.observations)).toContain('agent-scan/scan-root:docs/notes.md')
  })

  test('a focused file edit changes the request — the cache key covers content', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-agent-scan-focus-'))
    try {
      fs.cpSync(fixturePath('violations'), scratch, { recursive: true })

      const before = stubExec([goodReply()])
      await agentScan({ exec: before, instructions: 'x', focus: ['docs/**'] }).run({
        repositoryRoot: scratch,
      })

      fs.appendFileSync(path.join(scratch, 'docs/notes.md'), '\nedited\n')

      const after = stubExec([goodReply()])
      await agentScan({ exec: after, instructions: 'x', focus: ['docs/**'] }).run({
        repositoryRoot: scratch,
      })

      expect(before.requests[0]?.context).not.toEqual(after.requests[0]?.context)
      expect(after.requests[0]?.context).toContain('edited')
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('focus supports segment globs and bare directory prefixes', async () => {
    const exec = stubExec([goodReply()])

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x', focus: ['src/core/*.ts', 'docs'] })],
    })

    const context = exec.requests[0]?.context ?? ''
    expect(context).toContain('### src/core/health.ts')
    expect(context).toContain('### src/core/reverse.ts')
    expect(context).toContain('### docs/notes.md')
    expect(context).not.toContain('### src/orphan/thing.ts')
  })

  test('a truncated focused set is announced — the model must know its view is partial', async () => {
    const exec = stubExec([goodReply()])

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x', focus: ['src/**'], maxFiles: 2 })],
    })

    const context = exec.requests[0]?.context ?? ''
    // 6 files under src match, 2 excerpted, 4 announced as not shown.
    expect(context).toContain('NOTE: 4 focused files beyond budget not shown')
  })

  test('a focus that matches nothing fails the provider — never a clean empty scan', async () => {
    const exec = stubExec([goodReply()])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x', focus: ['infra/**'] })],
    })

    expect(exec.requests).toHaveLength(0)
    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('matched no files')
  })

  test('without focus the request is unchanged: listing plus agentic exploration', async () => {
    const exec = stubExec([goodReply()])

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    const request = exec.requests[0]
    expect(request?.agentic).toBe(true)
    expect(request?.context?.startsWith('### Scan instructions')).toBe(true)
    expect(request?.context).not.toContain('context-pack')
  })

  test('roots bound the listing, and a truncated listing is announced', async () => {
    const exec = stubExec([goodReply()])

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x', roots: ['src'], maxFiles: 2 })],
    })

    const context = exec.requests[0]?.context ?? ''
    expect(context).not.toContain('docs/notes.md')
    expect(context).toContain('- src/core/health.ts')
    // 6 files under src, 2 listed, 4 announced — the model must know the
    // listing is partial, or a thin listing reads as thin coverage.
    expect(context).toContain('truncated')
    expect(context).toContain('4 more files')
  })
})

describe('agentScan fails closed', () => {
  test('an exec failure fails the provider — one provider-failure error, not a clean scan', async () => {
    const exec = stubExec([{ ok: false, error: 'not logged in' }])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.subject).toEqual({ kind: 'provider', id: 'agent-scan' })
    expect(failure?.description).toContain('not logged in')
    // The failed provider contributed nothing — no half-scan.
    expect(result.observations.filter((o) => o.provider === 'agent-scan')).toEqual([])
  })

  test('an off-schema reply fails the provider', async () => {
    const exec = stubExec([ok({ observations: 'lots of them', examined: ['docs/notes.md'] })])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('did not match the requested schema')
  })

  test('an empty examined attestation is a failure, not a pass', async () => {
    const exec = stubExec([ok({ observations: [], examined: [] })])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    const failure = providerFailure(result.findings)
    expect(failure?.severity).toBe('error')
    expect(failure?.description).toContain('no files')
  })

  test('a nonexistent path anywhere in the reply fails the provider, never a silent drop', async () => {
    const hallucinated = [
      // In examined.
      ok({ observations: [], examined: ['docs/invented.md'] }),
      // In a subject ref.
      ok({
        observations: [{ kind: 'file', subject: { kind: 'file', id: 'src/ghost.ts' } }],
        examined: ['docs/notes.md'],
      }),
      // In a target ref.
      ok({
        observations: [
          {
            kind: 'dependency',
            subject: { kind: 'file', id: 'docs/notes.md' },
            target: { kind: 'file', id: 'src/ghost.ts' },
          },
        ],
        examined: ['docs/notes.md'],
      }),
      // In evidence.
      ok({
        observations: [
          {
            kind: 'file',
            subject: { kind: 'file', id: 'docs/notes.md' },
            evidence: [{ path: 'docs/ghost.md' }],
          },
        ],
        examined: ['docs/notes.md'],
      }),
    ]

    for (const reply of hallucinated) {
      const exec = stubExec([reply])
      const result = await runFixture('violations', {
        scan: [agentScan({ exec, instructions: 'x' })],
      })

      const failure = providerFailure(result.findings)
      expect(failure?.severity).toBe('error')
      expect(failure?.description).toContain('does not exist')
      expect(result.observations).toEqual([])
    }
  })

  test('absolute and root-escaping paths fail the provider', async () => {
    const escapes = [
      ok({ observations: [], examined: ['/etc/passwd'] }),
      ok({ observations: [], examined: ['../../secrets.txt'] }),
    ]

    for (const reply of escapes) {
      const exec = stubExec([reply])
      const result = await runFixture('violations', {
        scan: [agentScan({ exec, instructions: 'x' })],
      })

      const failure = providerFailure(result.findings)
      expect(failure?.severity).toBe('error')
      expect(failure?.description).toMatch(/not repository-relative|escapes the repository root/)
    }
  })

  test('non-file refs pass through unguarded — the vocabulary stays open', async () => {
    const exec = stubExec([
      ok({
        observations: [
          {
            kind: 'dependency',
            subject: { kind: 'service', id: 'api' },
            target: { kind: 'service', id: 'db' },
          },
        ],
        examined: ['docs/notes.md'],
      }),
    ])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    expect(providerFailure(result.findings)).toBeUndefined()
    expect(observationIds(result.observations)).toContain('agent-scan/dependency:api->db')
  })

  test('duplicate claims get ordinal ids instead of tripping the duplicate-id check', async () => {
    const claim = {
      kind: 'dependency',
      subject: { kind: 'file', id: 'docs/notes.md' },
      target: { kind: 'file', id: 'src/core/health.ts' },
    }
    const exec = stubExec([ok({ observations: [claim, claim], examined: ['docs/notes.md'] })])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    expect(providerFailure(result.findings)).toBeUndefined()
    const ids = observationIds(result.observations)
    expect(ids).toContain('agent-scan/dependency:docs/notes.md->src/core/health.ts')
    expect(ids).toContain('agent-scan/dependency:docs/notes.md->src/core/health.ts#1')
  })
})

describe('agentScan composition', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-agent-scan-cache-'))
  afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  test('works under cached(): the second run replays the reply without a call', async () => {
    const exec = stubExec([goodReply()])
    const provider = agentScan({
      exec: cached(exec, { directory: cacheDir }),
      instructions: 'read the docs',
    })

    const first = await runFixture('violations', { scan: [provider] })
    const second = await runFixture('violations', { scan: [provider] })

    // One live call across two pipeline runs; identical output either way.
    expect(exec.requests).toHaveLength(1)
    expect(providerFailure(second.findings)).toBeUndefined()
    expect(observationIds(second.observations)).toEqual(observationIds(first.observations))
  })

  test('two instances with different ids coexist without colliding', async () => {
    const docsExec = stubExec([
      ok({
        observations: [{ kind: 'file', subject: { kind: 'file', id: 'docs/notes.md' } }],
        examined: ['docs/notes.md'],
      }),
    ])
    const srcExec = stubExec([
      ok({
        observations: [{ kind: 'file', subject: { kind: 'file', id: 'src/core/health.ts' } }],
        // Deliberately the same attestation path as the docs instance: only
        // the provider-id namespace keeps the two scan-root ids distinct.
        examined: ['docs/notes.md'],
      }),
    ])

    const result = await runFixture('violations', {
      scan: [
        agentScan({ exec: docsExec, instructions: 'scan the docs', id: 'docs' }),
        agentScan({ exec: srcExec, instructions: 'scan the source', id: 'src' }),
      ],
    })

    expect(result.providers.scan).toEqual(['agent-scan:docs', 'agent-scan:src'])
    expect(providerFailure(result.findings)).toBeUndefined()
    expect(findingFor(result.findings, 'duplicate-id')).toBeUndefined()

    const ids = observationIds(result.observations)
    expect(ids).toContain('agent-scan:docs/scan-root:docs/notes.md')
    expect(ids).toContain('agent-scan:src/scan-root:docs/notes.md')
    expect(ids).toContain('agent-scan:docs/file:docs/notes.md')
    expect(ids).toContain('agent-scan:src/file:src/core/health.ts')
  })
})

// The provider id doubles as the finding-id and observation-id namespace; a
// rename would churn every consumer's baseline, so it is pinned.
test('the provider id is stable', () => {
  expect(SCAN_ID).toBe('agent-scan')
})
