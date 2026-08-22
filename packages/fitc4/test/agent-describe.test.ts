/**
 * The draft describer is judged on its request and its restraint: the context
 * carries the element's owned files under an announced budget, the reply is
 * schema-bound, and every failure shape becomes `undefined` — a kept TODO,
 * never a failed draft.
 */

import { describe, expect, test } from 'vitest'

import { draftDescriber } from '../src/agent/describe.ts'
import type { AgentExec, AgentReply, AgentRequest } from '../src/agent/exec.ts'
import type { DraftElementFacts } from '../src/draft.ts'
import { fixturePath } from './helpers.ts'

function stubExec(reply: AgentReply): AgentExec & { requests: AgentRequest[] } {
  const exec = {
    id: 'stub/model',
    requests: [] as AgentRequest[],
    async run(request: AgentRequest): Promise<AgentReply> {
      exec.requests.push(request)
      return reply
    },
  }
  return exec
}

function ok(value: unknown): AgentReply {
  return { ok: true, value: value as never, raw: JSON.stringify(value) }
}

const CORE: DraftElementFacts = {
  name: 'core',
  path: 'core',
  declared: 'src/core/**',
  ownedFiles: ['src/core/health.ts'],
}

describe('draftDescriber', () => {
  test('one one-shot call: owned files excerpted in the context, claim in the prompt, schema enforced', async () => {
    const exec = stubExec(ok({ description: 'Reports service health.' }))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(describe(CORE)).resolves.toBe('Reports service health.')

    expect(exec.requests).toHaveLength(1)
    const request = exec.requests[0]
    // The request names the element and its claim, so the cache key and any
    // recorded reply are self-describing.
    expect(request?.prompt).toContain("core, claiming 'src/core/**'")
    expect(request?.prompt).toContain('one or two plain sentences')
    // A one-shot call: no agentic exploration, everything is in the context.
    expect(request?.agentic).toBeUndefined()
    expect(request?.schema).toEqual({
      type: 'object',
      required: ['description'],
      properties: { description: { type: 'string' } },
    })
    const context = request?.context ?? ''
    expect(context.startsWith('context-pack v1')).toBe(true)
    expect(context).toContain('### Drafted element: core (app.core)')
    expect(context).toContain('Declared sources claim: src/core/**')
    expect(context).toContain('- src/core/health.ts')
    expect(context).toContain('### src/core/health.ts')
    // The excerpt carries the file's actual content.
    expect(context).toContain("export function health(): 'ok'")
  })

  test('an { ok: false } reply keeps the TODO', async () => {
    const exec = stubExec({ ok: false, error: 'not logged in' })
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(describe(CORE)).resolves.toBeUndefined()
  })

  test.each([
    ['an empty description', { description: '' }],
    ['a whitespace description', { description: '  \n ' }],
    ['a non-string description', { description: 7 }],
  ])('%s keeps the TODO', async (_label, value) => {
    const exec = stubExec(ok(value))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(describe(CORE)).resolves.toBeUndefined()
  })

  test('the proposal is flattened to one line, since a description is a single-line string', async () => {
    const exec = stubExec(ok({ description: '  Reports\nservice   health.  ' }))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(describe(CORE)).resolves.toBe('Reports service health.')
  })

  test('files beyond maxFiles and the byte budget are announced, never silently thinned', async () => {
    const exec = stubExec(ok({ description: 'Legacy helpers.' }))
    const describe = draftDescriber({
      exec,
      repositoryRoot: fixturePath('drift'),
      maxFiles: 1,
      budgetBytes: 600,
    })

    await describe({
      name: 'legacy',
      path: 'legacy',
      declared: 'src/legacy/**',
      ownedFiles: ['src/legacy/old.ts', 'src/legacy/older.ts'],
    })

    const context = exec.requests[0]?.context ?? ''
    // The facts list both files; the excerpts show one and announce the drop.
    expect(context).toContain('Owned files (2):')
    expect(context).toContain('- src/legacy/older.ts')
    expect(context).toContain('NOTE: 1 owned files of app.legacy beyond budget not shown')
    expect(context).not.toContain('### src/legacy/older.ts')
    // The budget bounds the whole pack, headers and notes aside.
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThan(1200)
  })

  test('an unreadable owned file degrades to an announced unreadable excerpt', async () => {
    const exec = stubExec(ok({ description: 'Something.' }))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await describe({
      name: 'ghost',
      path: 'ghost',
      declared: 'src/ghost/**',
      ownedFiles: ['src/ghost/missing.ts'],
    })

    expect(exec.requests[0]?.context).toContain('(unreadable)')
  })
})
