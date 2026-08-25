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
import { afterAll, describe, expect, test, vi } from 'vitest'

import { cached } from '../src/agent/cache.ts'
import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import { agentScan, DEFAULT_INSTRUCTIONS, PROVIDER_ID as SCAN_ID } from '../src/agent/scan.ts'
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
    // Exploration is told its working directory is the repository root, so it
    // passes the listed paths as written instead of inventing an absolute
    // prefix its read tool then refuses (measured live on the python eval).
    expect(request?.prompt).toContain('working directory is the repository root')
    // The scan budgets its own long call: exploration of a real repository
    // takes minutes, and the adapter's 120s extraction default would kill it.
    expect(request?.timeoutMs).toBe(600_000)
  })

  test('instructions default to the general import scan', async () => {
    const exec = stubExec([goodReply()])

    const result = await runFixture('violations', { scan: [agentScan({ exec })] })

    // agentScan({ exec }) is a working scanner with nothing written: the
    // shipped instructions are the generic import scan every first user of a
    // non-TypeScript repository was otherwise hand-writing in their config.
    const context = exec.requests[0]?.context ?? ''
    expect(context).toContain('### Scan instructions')
    expect(context).toContain(DEFAULT_INSTRUCTIONS)
    expect(DEFAULT_INSTRUCTIONS).toContain('whatever the language')
    expect(DEFAULT_INSTRUCTIONS).toContain('standard library')
    expect(providerFailure(result.findings)).toBeUndefined()
  })

  test('timeoutMs overrides the scan budget, on whichever request shape', async () => {
    const exec = stubExec([goodReply(), goodReply()])

    await runFixture('violations', {
      scan: [
        agentScan({ exec, id: 'a', instructions: 'x', timeoutMs: 90_000 }),
        agentScan({ exec, id: 'b', instructions: 'x', focus: ['docs/**'], timeoutMs: 90_000 }),
      ],
    })

    expect(exec.requests.map((request) => request.timeoutMs)).toEqual([90_000, 90_000])
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

describe('agentScan narration', () => {
  // Agent calls are the slow part of a run, so the provider announces each
  // one before it starts, through the context hook the pipeline prefixes.
  test('agentic mode announces the exploration before the call', async () => {
    const exec = stubExec([goodReply()])
    const messages: string[] = []

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
      onProgress: (message) => void messages.push(message),
    })

    expect(messages).toContainEqual(
      expect.stringMatching(/^agent-scan: exploring the repository with stub\/model, \d+ files listed$/),
    )
  })

  test('one-shot mode announces what it is sending and roughly how big', async () => {
    const exec = stubExec([goodReply()])
    const messages: string[] = []

    await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x', focus: ['docs/**'] })],
      onProgress: (message) => void messages.push(message),
    })

    expect(messages).toContainEqual(
      expect.stringMatching(/^agent-scan: asking stub\/model one-shot, about \d+ KB of instructions and excerpts$/),
    )
  })

  test('a long call narrates a still-waiting line with the elapsed time and the budget', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const exec: AgentExec = {
        id: 'stub/slow',
        async run() {
          await gate
          return goodReply()
        },
      }
      const messages: string[] = []
      const provider = agentScan({ exec, instructions: 'x' })
      const running = provider.run({
        repositoryRoot: fixturePath('violations'),
        progress: (message) => void messages.push(message),
      })

      // Two ticks in: the wait is narrated, and stays distinguishable from a
      // hang because each line carries the elapsed time and the hard stop.
      await vi.advanceTimersByTimeAsync(61_000)
      release()
      await running

      expect(messages).toContainEqual('still waiting on stub/slow, 30.0s of the 600s budget')
      expect(messages).toContainEqual('still waiting on stub/slow, 60.0s of the 600s budget')
      // The ticker dies with the call: nothing narrates after the reply.
      const after = messages.length
      await vi.advanceTimersByTimeAsync(61_000)
      expect(messages).toHaveLength(after)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('agentScan batching', () => {
  const scratchDirs: string[] = []
  afterAll(() => {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A scratch repository of empty files, for listings larger than one batch. */
  function scratchRepo(files: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-agent-scan-batch-'))
    scratchDirs.push(root)
    for (const relative of files) {
      const absolute = path.join(root, relative)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, '')
    }
    return root
  }

  function fileReply(file: string): AgentReply {
    return ok({
      observations: [{ kind: 'file', subject: { kind: 'file', id: file } }],
      examined: [file],
    })
  }

  const FIVE = ['a.py', 'b.py', 'c.py', 'd.py', 'e.py']

  test('a listing beyond batchFiles splits into batched calls and the replies merge', async () => {
    const repo = scratchRepo(FIVE)
    const exec = stubExec([fileReply('a.py'), fileReply('c.py'), fileReply('e.py')])
    const messages: string[] = []

    const observations = await agentScan({ exec, batchFiles: 2 }).run({
      repositoryRoot: repo,
      progress: (message) => void messages.push(message),
    })

    // Three deterministic batches of the sorted listing, one request each.
    expect(exec.requests).toHaveLength(3)
    expect(exec.requests[0]?.context).toContain('batch 1 of 3')
    expect(exec.requests[0]?.context).toContain('- a.py')
    expect(exec.requests[0]?.context).not.toContain('- c.py')
    expect(exec.requests[2]?.context).toContain('batch 3 of 3')
    expect(exec.requests[2]?.context).toContain('- e.py')
    // Each batch is told to stay on its own slice.
    expect(exec.requests[0]?.context).toContain('do not report observations about files outside this listing')

    // The merged result carries every batch's attestations and observations.
    const ids = observationIds(observations)
    expect(ids).toContain('scan-root:a.py')
    expect(ids).toContain('scan-root:c.py')
    expect(ids).toContain('scan-root:e.py')
    expect(ids).toContain('file:a.py')
    expect(ids).toContain('file:e.py')

    // Progress announces each batch by its position.
    expect(messages).toContainEqual('batch 1 of 3: exploring the repository with stub/model, 2 files listed')
    expect(messages).toContainEqual('batch 3 of 3: exploring the repository with stub/model, 1 file listed')
  })

  test('one batch keeps identical claims distinct by ordinal; across batches the repeat is overlap', async () => {
    const repo = scratchRepo(FIVE)
    const claim = {
      kind: 'dependency',
      subject: { kind: 'file', id: 'a.py' },
      target: { kind: 'file', id: 'b.py' },
    }
    const exec = stubExec([
      ok({ observations: [claim, claim], examined: ['a.py'] }),
      ok({ observations: [claim], examined: ['c.py'] }),
      fileReply('e.py'),
    ])

    const observations = await agentScan({ exec, batchFiles: 2 }).run({ repositoryRoot: repo })

    const ids = observationIds(observations).filter((id) => id.includes('a.py->b.py'))
    expect(ids).toEqual(['dependency:a.py->b.py', 'dependency:a.py->b.py#1'])
  })

  test('a failing batch names its position and how a rerun resumes', async () => {
    const repo = scratchRepo(FIVE)
    const exec = stubExec([fileReply('a.py'), { ok: false, error: 'timed out' }])

    await expect(
      agentScan({ exec, batchFiles: 2 }).run({ repositoryRoot: repo }),
    ).rejects.toThrow(/on batch 2 of 3: timed out.*cached\(\)/)
  })

  test('a batch that attests to examining nothing fails the scan', async () => {
    const repo = scratchRepo(FIVE)
    const exec = stubExec([fileReply('a.py'), ok({ observations: [], examined: [] })])

    await expect(
      agentScan({ exec, batchFiles: 2 }).run({ repositoryRoot: repo }),
    ).rejects.toThrow(/examining no files/)
  })

  test('the truncation note lands on the final batch only', async () => {
    const repo = scratchRepo(FIVE)
    const exec = stubExec([fileReply('a.py'), fileReply('c.py')])

    await agentScan({ exec, batchFiles: 2, maxFiles: 4 }).run({ repositoryRoot: repo })

    expect(exec.requests).toHaveLength(2)
    expect(exec.requests[0]?.context).not.toContain('truncated')
    expect(exec.requests[1]?.context).toContain('1 more files exist')
  })


  test('the partition keeps directories whole and packs siblings', async () => {
    const repo = scratchRepo([
      'api/handlers.py',
      'api/routes.py',
      'db/models.py',
      'db/queries.py',
      'web/pages.py',
      'web/views.py',
    ])
    const exec = stubExec([fileReply('api/handlers.py'), fileReply('web/pages.py')])
    const messages: string[] = []

    await agentScan({ exec, batchFiles: 4 }).run({
      repositoryRoot: repo,
      progress: (message) => void messages.push(message),
    })

    // Two sibling directories fill batch 1; web/ arrives intact as batch 2,
    // never split across a positional boundary.
    expect(exec.requests).toHaveLength(2)
    expect(exec.requests[0]?.context).toContain('- api/handlers.py')
    expect(exec.requests[0]?.context).toContain('- db/queries.py')
    expect(exec.requests[0]?.context).not.toContain('- web/')
    expect(exec.requests[1]?.context).toContain('- web/pages.py')
    expect(exec.requests[1]?.context).toContain('- web/views.py')
    // The narration names the area a batch covers.
    expect(messages).toContainEqual('batch 2 of 2: exploring web with stub/model, 2 files listed')
  })

  test('an oversized directory splits by its direct files; a subtree that fits rides whole', async () => {
    const repo = scratchRepo([
      'pkg/a.py',
      'pkg/b.py',
      'pkg/c.py',
      'pkg/d.py',
      'pkg/sub/x.py',
      'pkg/sub/y.py',
    ])
    const exec = stubExec([fileReply('pkg/a.py'), fileReply('pkg/d.py')])

    await agentScan({ exec, batchFiles: 3 }).run({ repositoryRoot: repo })

    expect(exec.requests).toHaveLength(2)
    expect(exec.requests[0]?.context).toContain('- pkg/a.py')
    expect(exec.requests[0]?.context).toContain('- pkg/c.py')
    // The remainder of pkg coalesces with the whole of pkg/sub.
    expect(exec.requests[1]?.context).toContain('- pkg/d.py')
    expect(exec.requests[1]?.context).toContain('- pkg/sub/x.py')
    expect(exec.requests[1]?.context).toContain('- pkg/sub/y.py')
  })

  test('batches run concurrently by default', async () => {
    const repo = scratchRepo(FIVE)
    let arrived = 0
    let releaseAll!: () => void
    const everyoneHere = new Promise<void>((resolve) => (releaseAll = resolve))
    const exec: AgentExec = {
      id: 'stub/pool',
      async run(request: AgentRequest): Promise<AgentReply> {
        arrived += 1
        if (arrived === 3) releaseAll()
        // Every reply is held until all three requests have arrived: a
        // sequential dispatch would deadlock here, so completing at all is
        // the concurrency assertion.
        await everyoneHere
        const file = /^- (.+)$/m.exec(request.context ?? '')?.[1] ?? ''
        return ok({ observations: [], examined: [file] })
      },
    }

    const observations = await agentScan({ exec, batchFiles: 2 }).run({ repositoryRoot: repo })

    expect(observationIds(observations)).toEqual(['scan-root:a.py', 'scan-root:c.py', 'scan-root:e.py'])
  }, 10_000)

  test('concurrency: 1 keeps the scan strictly sequential', async () => {
    const repo = scratchRepo(FIVE)
    let active = 0
    let peak = 0
    const exec: AgentExec = {
      id: 'stub/serial',
      async run(request: AgentRequest): Promise<AgentReply> {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        const file = /^- (.+)$/m.exec(request.context ?? '')?.[1] ?? ''
        return ok({ observations: [], examined: [file] })
      },
    }

    await agentScan({ exec, batchFiles: 2, concurrency: 1 }).run({ repositoryRoot: repo })

    expect(peak).toBe(1)
  })

  test('a failure stops the pool from taking new batches; in-flight siblings finish', async () => {
    const repo = scratchRepo([...'abcdefghijkl'].map((letter) => `${letter}.py`))
    const exec = stubExec([{ ok: false, error: 'rate limited' }])

    await expect(
      agentScan({ exec, batchFiles: 2, concurrency: 2 }).run({ repositoryRoot: repo }),
    ).rejects.toThrow(/on batch \d+ of 6: rate limited.*cached\(\)/)

    // Two workers had two batches in flight; the other four never launched.
    expect(exec.requests.length).toBeLessThanOrEqual(3)
  })

  test('replies merge in batch order even when completion is out of order', async () => {
    const repo = scratchRepo(FIVE)
    const claim = {
      kind: 'dependency',
      subject: { kind: 'file', id: 'a.py' },
      target: { kind: 'file', id: 'b.py' },
    }
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const exec: AgentExec = {
      id: 'stub/shuffled',
      async run(request: AgentRequest): Promise<AgentReply> {
        const listed = /^- (.+)$/m.exec(request.context ?? '')?.[1] ?? ''
        if (listed === 'a.py') {
          await firstGate
          return ok({ observations: [claim, claim], examined: ['a.py'] })
        }
        if (listed === 'e.py') releaseFirst()
        return ok({ observations: listed === 'c.py' ? [claim] : [], examined: [listed] })
      },
    }

    const observations = await agentScan({ exec, batchFiles: 2 }).run({ repositoryRoot: repo })

    // Batch 1 finished last, yet its two claims kept the natural key and the
    // ordinal, and batch 2's repeat merged away: the same output a sequential
    // run produces.
    const ids = observationIds(observations).filter((id) => id.includes('a.py->b.py'))
    expect(ids).toEqual(['dependency:a.py->b.py', 'dependency:a.py->b.py#1'])
  }, 10_000)

  test('focused excerpts batch the same way, one-shot per slice', async () => {
    const repo = scratchRepo(FIVE)
    const exec = stubExec([fileReply('a.py'), fileReply('c.py'), fileReply('e.py')])

    await agentScan({ exec, batchFiles: 2, focus: ['**'] }).run({ repositoryRoot: repo })

    expect(exec.requests).toHaveLength(3)
    expect(exec.requests.every((request) => request.agentic === undefined)).toBe(true)
    expect(exec.requests[1]?.context).toContain('batch 2 of 3')
    expect(exec.requests[1]?.context).toContain('### c.py')
    expect(exec.requests[1]?.context).not.toContain('### a.py')
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
      // In a target ref of a kind with no downgrade shape (a dependency's
      // missing file target downgrades instead; see the test below).
      ok({
        observations: [
          {
            kind: 'doc-link',
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

  test("a dependency target that names no real file downgrades to unresolved, not a dead scan", async () => {
    // Measured on a live run: the model wrote docs/assets/... for
    // docs/docs/assets/..., one dropped path segment, and fail-closed would
    // have discarded every completed batch over it. A missing dependency
    // target is a failed resolution with a reply shape of its own, so it
    // converts to 'unresolved-dependency' and surfaces as the
    // unresolved-import warning. Subjects, evidence, and attestations keep
    // failing the scan: those say what was covered.
    const exec = stubExec([
      ok({
        observations: [
          {
            kind: 'dependency',
            subject: { kind: 'file', id: 'docs/notes.md' },
            target: { kind: 'file', id: 'docs/assets/ghost.svg' },
            evidence: [{ path: 'docs/notes.md', line: 1 }],
          },
        ],
        examined: ['docs/notes.md'],
      }),
    ])

    const result = await runFixture('violations', {
      scan: [agentScan({ exec, instructions: 'x' })],
    })

    expect(providerFailure(result.findings)).toBeUndefined()
    const downgraded = result.observations.find((o) => o.kind === 'unresolved-dependency')
    expect(downgraded?.id).toBe('agent-scan/unresolved-dependency:docs/notes.md->docs/assets/ghost.svg')
    expect(downgraded?.target).toEqual({ kind: 'module', id: 'docs/assets/ghost.svg' })
    expect(findingFor(result.findings, 'unresolved-import')?.severity).toBe('warning')
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
