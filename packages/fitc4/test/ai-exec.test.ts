/**
 * Adapter tests run against fake CLI binaries — tiny scripts that record their
 * argv and stdin and print a canned reply. No real AI is ever invoked here:
 * what these tests pin down is the exec contract (isolation flags, stdin
 * composition, envelope parsing, failure shapes), which is exactly the part a
 * real model cannot make deterministic.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { claudeCli } from '../src/ai/claude-cli.ts'
import { codexCli } from '../src/ai/codex-cli.ts'
import { extractJson, finishReply, schemaMismatch } from '../src/ai/exec.ts'

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-fake-ai-'))
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }))

const FAKE_ENV = ['FAKE_CAPTURE', 'FAKE_RESULT', 'FAKE_ENVELOPE', 'FAKE_EXIT', 'FAKE_NO_REPLY']
afterEach(() => {
  for (const name of FAKE_ENV) delete process.env[name]
})

function fakeBinary(name: string, script: string): string {
  const file = path.join(workDir, name)
  fs.writeFileSync(file, `#!/usr/bin/env node\n${script}`)
  fs.chmodSync(file, 0o755)
  return file
}

interface Capture {
  argv: string[]
  stdin: string
  schema?: string | null
}

function readCapture(): Capture {
  return JSON.parse(fs.readFileSync(process.env['FAKE_CAPTURE'] ?? '', 'utf8')) as Capture
}

function captureTo(name: string): void {
  process.env['FAKE_CAPTURE'] = path.join(workDir, name)
}

const fakeClaude = fakeBinary(
  'fake-claude.cjs',
  `
const fs = require('node:fs')
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  if (process.env.FAKE_CAPTURE) {
    fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin }))
  }
  if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT))
  process.stdout.write(
    process.env.FAKE_ENVELOPE ??
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: process.env.FAKE_RESULT ?? 'ok' }),
  )
})
`,
)

const fakeCodex = fakeBinary(
  'fake-codex.cjs',
  `
const fs = require('node:fs')
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const argv = process.argv.slice(2)
  const out = argv[argv.indexOf('--output-last-message') + 1]
  const schemaAt = argv.indexOf('--output-schema')
  const schema = schemaAt >= 0 ? fs.readFileSync(argv[schemaAt + 1], 'utf8') : null
  if (process.env.FAKE_CAPTURE) {
    fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ argv, stdin, schema }))
  }
  if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT))
  if (process.env.FAKE_NO_REPLY !== '1') fs.writeFileSync(out, process.env.FAKE_RESULT ?? 'ok')
})
`,
)

const slowBinary = fakeBinary('fake-slow.cjs', 'setTimeout(() => {}, 30000)\n')

describe('claudeCli', () => {
  test('runs isolated and tool-less by default, with the composed input on stdin', async () => {
    captureTo('claude-default.json')
    process.env['FAKE_RESULT'] = '{}'

    const reply = await claudeCli({ binary: fakeClaude }).run({
      prompt: 'judge this',
      context: 'the whole world',
      schema: { type: 'object' },
    })

    expect(reply.ok).toBe(true)
    const { argv, stdin } = readCapture()
    expect(argv).toContain('--print')
    expect(argv.slice(argv.indexOf('--output-format'))).toContain('json')
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(argv[argv.indexOf('--tools') + 1]).toBe('')
    expect(stdin).toContain('## Context\n\nthe whole world')
    expect(stdin).toContain('## Reply format')
    expect(stdin).toContain('## Task\n\njudge this')
  })

  test('agentic requests get read-only tools and nothing else', async () => {
    captureTo('claude-agentic.json')

    await claudeCli({ binary: fakeClaude, model: 'sonnet' }).run({ prompt: 'explore', agentic: true })

    const { argv } = readCapture()
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
  })

  test('a fenced reply still satisfies the schema', async () => {
    process.env['FAKE_RESULT'] = '```json\n{"a": 1}\n```'

    const reply = await claudeCli({ binary: fakeClaude }).run({ prompt: 'x', schema: { type: 'object' } })

    expect(reply).toMatchObject({ ok: true, value: { a: 1 } })
  })

  test('without a schema the raw text is the value', async () => {
    process.env['FAKE_RESULT'] = 'plain prose'

    const reply = await claudeCli({ binary: fakeClaude }).run({ prompt: 'x' })

    expect(reply).toMatchObject({ ok: true, value: 'plain prose' })
  })

  test('an error envelope, a non-zero exit, and a malformed envelope all fail visibly', async () => {
    process.env['FAKE_ENVELOPE'] = JSON.stringify({ type: 'result', is_error: true, result: 'boom' })
    expect((await claudeCli({ binary: fakeClaude }).run({ prompt: 'x' })).ok).toBe(false)
    delete process.env['FAKE_ENVELOPE']

    process.env['FAKE_EXIT'] = '2'
    const exited = await claudeCli({ binary: fakeClaude }).run({ prompt: 'x' })
    expect(exited).toMatchObject({ ok: false })
    expect(!exited.ok && exited.error).toContain('exited 2')
    delete process.env['FAKE_EXIT']

    process.env['FAKE_ENVELOPE'] = 'not json at all'
    const malformed = await claudeCli({ binary: fakeClaude }).run({ prompt: 'x' })
    expect(!malformed.ok && malformed.error).toContain('malformed envelope')
  })

  test('a missing binary is a reply, not a crash', async () => {
    const reply = await claudeCli({ binary: path.join(workDir, 'does-not-exist') }).run({ prompt: 'x' })

    expect(reply.ok).toBe(false)
  })

  test('a hung CLI is killed at the timeout', async () => {
    const reply = await claudeCli({ binary: slowBinary, timeoutMs: 200 }).run({ prompt: 'x' })

    expect(!reply.ok && reply.error).toContain('timed out')
  })
})

describe('codexCli', () => {
  test('runs ephemeral, config-ignoring, and sandboxed read-only, with the schema in a file', async () => {
    captureTo('codex-default.json')
    process.env['FAKE_RESULT'] = '{"b": 2}'

    const reply = await codexCli({ binary: fakeCodex, model: 'some-model' }).run({
      prompt: 'judge this',
      context: 'ctx',
      schema: { type: 'object' },
      cwd: workDir,
    })

    expect(reply).toMatchObject({ ok: true, value: { b: 2 } })
    const { argv, stdin, schema } = readCapture()
    expect(argv[0]).toBe('exec')
    expect(argv).toContain('--ephemeral')
    expect(argv).toContain('--ignore-user-config')
    expect(argv).toContain('--ignore-rules')
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(argv[argv.indexOf('--model') + 1]).toBe('some-model')
    expect(argv[argv.indexOf('--cd') + 1]).toBe(workDir)
    expect(argv[argv.length - 1]).toBe('-')
    expect(schema).toBe(JSON.stringify({ type: 'object' }))
    expect(stdin).toContain('## Task\n\njudge this')
  })

  test('object schemas are pinned closed for strict structured output', async () => {
    captureTo('codex-schema.json')

    await codexCli({ binary: fakeCodex }).run({
      prompt: 'x',
      schema: {
        type: 'object',
        required: ['files'],
        properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } } },
      },
    })

    const written = JSON.parse(readCapture().schema ?? '') as {
      additionalProperties?: boolean
      properties: { files: { items: { additionalProperties?: boolean } } }
    }
    expect(written.additionalProperties).toBe(false)
    expect(written.properties.files.items.additionalProperties).toBe(false)
  })

  test('a non-zero exit and a missing reply file both fail visibly', async () => {
    process.env['FAKE_EXIT'] = '3'
    const exited = await codexCli({ binary: fakeCodex }).run({ prompt: 'x' })
    expect(!exited.ok && exited.error).toContain('exited 3')
    delete process.env['FAKE_EXIT']

    process.env['FAKE_NO_REPLY'] = '1'
    const silent = await codexCli({ binary: fakeCodex }).run({ prompt: 'x' })
    expect(!silent.ok && silent.error).toContain('wrote no reply')
  })
})

describe('extractJson', () => {
  test('parses bare, fenced, and prose-wrapped JSON, and refuses non-JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n[1, 2]\n```')).toEqual([1, 2])
    expect(extractJson('Sure! Here it is: {"a": {"b": 2}} — hope that helps')).toEqual({ a: { b: 2 } })
    expect(extractJson('no json here')).toBeUndefined()
  })
})

// Parsing is not conforming: a reply that is JSON but not the requested shape
// must be a visible failure, not a value a gating provider misreads as
// absence-of-problem.
describe('schema conformance', () => {
  test('a JSON reply missing a required field is a failure, not a value', () => {
    const reply = finishReply(
      {
        prompt: 'judge',
        schema: {
          type: 'object',
          required: ['matches'],
          properties: { matches: { type: 'boolean' } },
        },
      },
      '{}',
    )

    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error).toContain("missing 'matches'")
  })

  test('nested items, union types, and required keys are all checked', () => {
    const schema = {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'element'],
            properties: { path: { type: 'string' }, element: { type: ['string', 'null'] } },
          },
        },
      },
    }

    expect(schemaMismatch({ files: [{ path: 'a.ts', element: null }] }, schema)).toBeUndefined()
    expect(schemaMismatch({ files: [{ path: 'a.ts', element: 5 }] }, schema)).toContain(
      '$.files[0].element',
    )
    expect(schemaMismatch({ files: [{ path: 'a.ts' }] }, schema)).toContain("missing 'element'")
    expect(schemaMismatch({ files: 'a.ts' }, schema)).toContain('$.files')
  })

  test('enums are honoured; keywords outside the subset degrade laxly, never reject', () => {
    expect(schemaMismatch('maybe', { enum: ['yes', 'no'] })).toContain('must be one of')
    expect(schemaMismatch({ anything: 1 }, { type: 'object', minProperties: 5 })).toBeUndefined()
  })
})
