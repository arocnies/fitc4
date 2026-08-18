import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { cached } from '../src/ai/cache.ts'
import type { AiExec, AiReply } from '../src/ai/exec.ts'

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-ai-cache-'))
afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

function countingExec(reply: AiReply, identity?: { id?: string; fingerprint?: string }): AiExec & { calls: number } {
  const exec = {
    id: identity?.id ?? 'stub/model',
    fingerprint: identity?.fingerprint,
    calls: 0,
    async run(): Promise<AiReply> {
      exec.calls += 1
      return reply
    },
  }
  return exec
}

/** The single entry file a run wrote into `directory`. */
function entryFile(directory: string): string {
  const entries = fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
  expect(entries).toHaveLength(1)
  return path.join(directory, entries[0] as string)
}

describe('cached', () => {
  test('identical requests hit the inner exec once', async () => {
    const inner = countingExec({ ok: true, value: { a: 1 }, raw: '{"a":1}' })
    const exec = cached(inner, { directory: path.join(cacheDir, 'hits') })

    const first = await exec.run({ prompt: 'same', context: 'ctx' })
    const second = await exec.run({ prompt: 'same', context: 'ctx' })

    expect(inner.calls).toBe(1)
    expect(first).toMatchObject({ ok: true, value: { a: 1 } })
    expect(second).toMatchObject({ ok: true, value: { a: 1 } })
  })

  test('any changed input is a different key', async () => {
    const inner = countingExec({ ok: true, value: 'v', raw: 'v' })
    const exec = cached(inner, { directory: path.join(cacheDir, 'keys') })

    await exec.run({ prompt: 'p', context: 'ctx' })
    await exec.run({ prompt: 'p2', context: 'ctx' })
    await exec.run({ prompt: 'p', context: 'ctx2' })
    await exec.run({ prompt: 'p', context: 'ctx', agentic: true })
    await exec.run({ prompt: 'p', context: 'ctx', schema: { type: 'string' } })
    await exec.run({ prompt: 'p', context: 'ctx', schema: { type: 'number' } })

    expect(inner.calls).toBe(6)
  })

  // The adapter identity carries the model, and the fingerprint carries the
  // fixed prompt-and-flags surface. Dropping either from the key would replay
  // one model's reply as another's — with this whole suite still green.
  test('a different exec id or fingerprint is a different key', async () => {
    const directory = path.join(cacheDir, 'identity')
    const haiku = countingExec({ ok: true, value: 'v', raw: 'v' }, { id: 'cli/haiku' })
    const sonnet = countingExec({ ok: true, value: 'v', raw: 'v' }, { id: 'cli/sonnet' })
    const reprompted = countingExec(
      { ok: true, value: 'v', raw: 'v' },
      { id: 'cli/haiku', fingerprint: 'prompt-v2' },
    )

    await cached(haiku, { directory }).run({ prompt: 'p' })
    await cached(sonnet, { directory }).run({ prompt: 'p' })
    await cached(reprompted, { directory }).run({ prompt: 'p' })

    expect(haiku.calls).toBe(1)
    expect(sonnet.calls).toBe(1)
    expect(reprompted.calls).toBe(1)
  })

  test('failures are never cached', async () => {
    const inner = countingExec({ ok: false, error: 'down' })
    const exec = cached(inner, { directory: path.join(cacheDir, 'failures') })

    await exec.run({ prompt: 'p' })
    const second = await exec.run({ prompt: 'p' })

    expect(inner.calls).toBe(2)
    expect(second.ok).toBe(false)
  })

  // A hit is trusted no further than a live reply. A malformed entry read as
  // `value: undefined` would flow into semantic-review's `matches !== false`
  // as absence-of-problem — a gating review passing on garbage.
  test.each([
    ['truncated JSON', '{"value": {"matches"'],
    ['a non-object entry', '"just a string"'],
    ['a missing raw', '{"value": {"matches": true, "issues": []}}'],
    ['a missing value', '{"raw": "{}"}'],
  ])('a corrupted entry (%s) is a miss and gets rewritten', async (_label, garbage) => {
    const directory = path.join(cacheDir, `corrupt-${garbage.length}`)
    const inner = countingExec({ ok: true, value: { matches: true, issues: [] }, raw: '{}' })
    const exec = cached(inner, { directory })
    const request = { prompt: 'judge' }

    await exec.run(request)
    fs.writeFileSync(entryFile(directory), garbage)

    const reply = await exec.run(request)

    expect(inner.calls).toBe(2)
    expect(reply).toMatchObject({ ok: true, value: { matches: true, issues: [] } })
    // The live reply overwrote the bad entry, so the next run hits again.
    expect(JSON.parse(fs.readFileSync(entryFile(directory), 'utf8'))).toEqual({
      value: { matches: true, issues: [] },
      raw: '{}',
    })
    await exec.run(request)
    expect(inner.calls).toBe(2)
  })

  test('a well-formed entry that no longer matches the requested schema is a miss', async () => {
    const directory = path.join(cacheDir, 'off-schema')
    const inner = countingExec({ ok: true, value: { matches: false, issues: [] }, raw: 'live' })
    const exec = cached(inner, { directory })
    const request = {
      prompt: 'judge',
      schema: { type: 'object' as const, required: ['matches'], properties: { matches: { type: 'boolean' } } },
    }

    await exec.run(request)
    // Recorded before the schema grew `matches`, say: valid JSON, wrong shape.
    fs.writeFileSync(entryFile(directory), JSON.stringify({ value: {}, raw: '{}' }))

    const reply = await exec.run(request)

    expect(inner.calls).toBe(2)
    expect(reply).toMatchObject({ ok: true, value: { matches: false } })
  })

  test('a schema-free request accepts any structurally sound entry', async () => {
    const directory = path.join(cacheDir, 'schema-free')
    const inner = countingExec({ ok: true, value: 'live', raw: 'live' })
    const exec = cached(inner, { directory })

    await exec.run({ prompt: 'p' })
    fs.writeFileSync(entryFile(directory), JSON.stringify({ value: { odd: true }, raw: 'kept' }))

    const reply = await exec.run({ prompt: 'p' })

    expect(inner.calls).toBe(1)
    expect(reply).toMatchObject({ ok: true, value: { odd: true }, raw: 'kept' })
  })
})
