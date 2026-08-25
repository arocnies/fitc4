/**
 * The draft describer is judged on its request and on the line it draws: the
 * context carries the element's owned files under an announced budget, the
 * reply is schema-bound, an abstention becomes `undefined` (a kept TODO), and
 * a transport failure throws, because an agent that never ran did not decline.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  test('a container is described from its children, zero file reads', async () => {
    const exec = stubExec(ok({ description: 'Everything the demo serves.' }))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    const container: DraftElementFacts = {
      name: 'src',
      path: 'src',
      ownedFiles: [],
      children: [
        { path: 'src.core', name: 'core', description: 'Reports service health.' },
        { path: 'src.legacy', name: 'legacy' },
      ],
    }
    await expect(describe(container)).resolves.toBe('Everything the demo serves.')

    const request = exec.requests[0]
    expect(request?.prompt).toContain('container element')
    expect(request?.prompt).toContain('synthesized from what its children do')
    // A described child arrives with its settled description; an abstained
    // one is announced as such rather than shown blank.
    expect(request?.context).toContain('- core (app.src.core): Reports service health.')
    expect(request?.context).toContain('- legacy (app.src.legacy): no description yet')
  })

  test('no claim, no files, no children is an abstention without a call', async () => {
    const exec = stubExec(ok({ description: 'should never be asked' }))
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(
      describe({ name: 'ghost', path: 'ghost', ownedFiles: [] }),
    ).resolves.toBeUndefined()
    expect(exec.requests).toHaveLength(0)
  })

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
    // The prompt steers away from the drift it would otherwise invite: a
    // description built from ports and env vars becomes description-drift the
    // day a port changes, and one built from the element's name says nothing.
    expect(request?.prompt).toContain('durable responsibility')
    expect(request?.prompt).toContain('ports, hostnames, environment')
    expect(request?.prompt).toContain('Do not restate the element name')
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

  // The failure this split exists for: a logged-out CLI used to read as a
  // model declining to answer, per element, and exit 0.
  test('an { ok: false } reply throws, naming the exec and the adapter error', async () => {
    const exec = stubExec({ ok: false, error: 'not logged in' })
    const describe = draftDescriber({ exec, repositoryRoot: fixturePath('drift') })

    await expect(describe(CORE)).rejects.toThrow('stub/model could not run: not logged in')
  })

  test.each([
    ['an empty description', { description: '' }],
    ['a whitespace description', { description: '  \n ' }],
    ['a non-string description', { description: 7 }],
  ])('%s is an abstention and keeps the TODO', async (_label, value) => {
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

  test('a fragment claim anchors the excerpt at the fragment, not the file head', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-describe-'))
    const compose = [
      '# header comment',
      'services:',
      '  studio:',
      '    image: studio-image',
      ...Array.from({ length: 80 }, (_, index) => `    padding_${index}: value`),
      '  auth:',
      '    image: auth-image',
      '    command: serve',
    ].join('\n')
    fs.mkdirSync(path.join(root, 'docker'))
    fs.writeFileSync(path.join(root, 'docker', 'compose.yml'), compose)

    const exec = stubExec(ok({ description: 'Runs the auth service.' }))
    const describe = draftDescriber({ exec, repositoryRoot: root, excerptChars: 200 })

    await describe({
      name: 'auth',
      path: 'compose_yml.auth',
      declared: 'docker/compose.yml#services.auth',
      ownedFiles: ['docker/compose.yml'],
    })

    const context = exec.requests[0]?.context ?? ''
    // The window starts at the fragment and says so; the head-of-file padding
    // that would have crowded out the fragment is announced, not shown.
    expect(context).toContain('anchored at the claimed fragment')
    expect(context).toContain("[anchored at 'auth', line 85; 84 earlier lines not shown]")
    expect(context).toContain('image: auth-image')
    expect(context).not.toContain('image: studio-image')
  })

  test('the anchor prefers the defining line over an earlier mention', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-describe-'))
    const compose = [
      'services:',
      '  storage:',
      '    depends_on:',
      '      - imgproxy',
      '      imgproxy:',
      '        condition: service_started',
      '  imgproxy:',
      '    image: imgproxy-image',
    ].join('\n')
    fs.mkdirSync(path.join(root, 'docker'))
    fs.writeFileSync(path.join(root, 'docker', 'compose.yml'), compose)

    const exec = stubExec(ok({ description: 'Proxies images.' }))
    const describe = draftDescriber({ exec, repositoryRoot: root, excerptChars: 200 })

    await describe({
      name: 'imgproxy',
      path: 'compose_yml.imgproxy',
      declared: 'docker/compose.yml#services.imgproxy',
      ownedFiles: ['docker/compose.yml'],
    })

    const context = exec.requests[0]?.context ?? ''
    // Storage's depends_on mentions imgproxy twice first, once list-form and
    // once mapping-form; the mapping-form entry starts with the anchor too,
    // but the shallower definition line is where the window must open.
    expect(context).toContain("[anchored at 'imgproxy', line 7; 6 earlier lines not shown]")
    expect(context).toContain('image: imgproxy-image')
  })

  test('a fragment anchor the file does not contain falls back to the head, announced', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-describe-'))
    fs.mkdirSync(path.join(root, 'docker'))
    fs.writeFileSync(path.join(root, 'docker', 'compose.yml'), 'services:\n  studio: {}\n')

    const exec = stubExec(ok({ description: 'Something.' }))
    const describe = draftDescriber({ exec, repositoryRoot: root })

    await describe({
      name: 'ghost',
      path: 'compose_yml.ghost',
      declared: 'docker/compose.yml#services.ghost',
      ownedFiles: ['docker/compose.yml'],
    })

    const context = exec.requests[0]?.context ?? ''
    expect(context).toContain("[fragment anchor 'ghost' not found in the file; showing the head instead]")
    expect(context).toContain('studio: {}')
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
