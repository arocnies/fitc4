import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { cached } from '../src/ai/cache.ts'
import type { AiExec, AiReply } from '../src/ai/exec.ts'

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-ai-cache-'))
afterAll(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

function countingExec(reply: AiReply): AiExec & { calls: number } {
  const exec = {
    id: 'stub/model',
    calls: 0,
    async run(): Promise<AiReply> {
      exec.calls += 1
      return reply
    },
  }
  return exec
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

    expect(inner.calls).toBe(4)
  })

  test('failures are never cached', async () => {
    const inner = countingExec({ ok: false, error: 'down' })
    const exec = cached(inner, { directory: path.join(cacheDir, 'failures') })

    await exec.run({ prompt: 'p' })
    const second = await exec.run({ prompt: 'p' })

    expect(inner.calls).toBe(2)
    expect(second.ok).toBe(false)
  })
})
