/**
 * Adapter tests run against fake CLI binaries — tiny scripts that record their
 * argv and stdin and print a canned reply. No real agent CLI is ever invoked here:
 * what these tests pin down is the exec contract (isolation flags, stdin
 * composition, envelope parsing, failure shapes), which is exactly the part a
 * real model cannot make deterministic.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

import { claudeCli } from '../src/agent/claude-cli.ts'
import { codexCli, strictSchema } from '../src/agent/codex-cli.ts'
import { extractJson, finishReply, schemaMismatch } from '../src/agent/exec.ts'
import type { JsonObject, JsonValue } from '../src/types.ts'

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-fake-agent-'))
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

  test('the written schema satisfies strict mode; optional-key nulls are stripped from the reply', async () => {
    captureTo('codex-nulls.json')
    const schema: JsonObject = {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'element'],
            properties: {
              path: { type: 'string' },
              element: { type: ['string', 'null'] },
              reason: { type: 'string' },
            },
          },
        },
      },
    }
    // The strict transform makes `reason` required-but-nullable, so the model
    // answers null where the plain schema lets it omit the key. `element` is
    // required and legitimately nullable: its null must survive.
    process.env['FAKE_RESULT'] = JSON.stringify({
      files: [{ path: 'a.ts', element: null, reason: null }],
    })

    const reply = await codexCli({ binary: fakeCodex }).run({ prompt: 'x', schema })

    expect(reply).toMatchObject({ ok: true, value: { files: [{ path: 'a.ts', element: null }] } })
    if (reply.ok) {
      const files = (reply.value as { files: JsonObject[] }).files
      expect(files[0]).not.toHaveProperty('reason')
      // The stripped value passes the provider-side check against the
      // ORIGINAL schema, where `reason` is optional and non-nullable.
      expect(schemaMismatch(reply.value, schema)).toBeUndefined()
      // The raw text is the model's, nulls and all — what a cache records.
      expect(reply.raw).toContain('"reason":null')
    }
    expectStrictObjectNodes(JSON.parse(readCapture().schema ?? '') as JsonValue)
  })

  test('a null on a required non-nullable key still fails the schema check', async () => {
    const schema: JsonObject = {
      type: 'object',
      required: ['matches'],
      properties: { matches: { type: 'boolean' } },
    }
    process.env['FAKE_RESULT'] = JSON.stringify({ matches: null })

    const reply = await codexCli({ binary: fakeCodex }).run({ prompt: 'x', schema })

    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.error).toContain('$.matches')
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

  test('a hung CLI is killed at the timeout', async () => {
    const reply = await codexCli({ binary: slowBinary, timeoutMs: 200 }).run({ prompt: 'x' })

    expect(!reply.ok && reply.error).toContain('timed out')
  })
})

/**
 * OpenAI strict mode's rule, asserted recursively: every object node with
 * `properties` pins `additionalProperties: false` and lists EVERY property
 * key in `required`.
 */
function expectStrictObjectNodes(node: JsonValue): void {
  if (Array.isArray(node)) {
    for (const entry of node) expectStrictObjectNodes(entry)
    return
  }
  if (node === null || typeof node !== 'object') return

  const properties = node['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    expect(node['additionalProperties']).toBe(false)
    expect([...(node['required'] as string[])].sort()).toEqual(Object.keys(properties).sort())
    for (const schema of Object.values(properties)) expectStrictObjectNodes(schema)
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'properties') expectStrictObjectNodes(value)
  }
}

describe('strictSchema', () => {
  test('optional plain-typed properties become required-but-nullable', () => {
    const strict = strictSchema({
      type: 'array',
      items: {
        type: 'object',
        required: ['candidateId', 'elementId'],
        properties: {
          candidateId: { type: 'string' },
          elementId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    }) as { items: { required: string[]; additionalProperties: boolean; properties: JsonObject } }

    expect(strict.items.additionalProperties).toBe(false)
    expect([...strict.items.required].sort()).toEqual(['candidateId', 'elementId', 'reason'])
    expect(strict.items.properties['candidateId']).toEqual({ type: 'string' })
    expect(strict.items.properties['reason']).toEqual({ type: ['string', 'null'] })
    expectStrictObjectNodes(strict as unknown as JsonValue)
  })

  test('an all-required object changes only by additionalProperties; nullable unions stay put', () => {
    const strict = strictSchema({
      type: 'object',
      required: ['path', 'element'],
      properties: { path: { type: 'string' }, element: { type: ['string', 'null'] } },
    })

    expect(strict).toEqual({
      type: 'object',
      required: ['path', 'element'],
      properties: { path: { type: 'string' }, element: { type: ['string', 'null'] } },
      additionalProperties: false,
    })
  })

  test('structured optionals union with null via anyOf, and nesting recurses throughout', () => {
    const strict = strictSchema({
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string' },
        target: {
          type: 'object',
          required: ['kind', 'id'],
          properties: { kind: { type: 'string' }, id: { type: 'string' } },
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' }, line: { type: 'integer' } },
          },
        },
      },
    }) as { properties: JsonObject; required: string[] }

    expect([...strict.required].sort()).toEqual(['evidence', 'kind', 'target'])
    expect(strict.properties['target']).toEqual({
      anyOf: [
        {
          type: 'object',
          required: ['kind', 'id'],
          properties: { kind: { type: 'string' }, id: { type: 'string' } },
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    })
    const evidence = strict.properties['evidence'] as { anyOf: JsonObject[] }
    expect(evidence.anyOf[1]).toEqual({ type: 'null' })
    expect(evidence.anyOf[0]).toEqual({
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'line'],
        properties: { path: { type: 'string' }, line: { type: ['integer', 'null'] } },
        additionalProperties: false,
      },
    })
    expectStrictObjectNodes(strict as unknown as JsonValue)
  })

  test('every provider reply schema shape passes the strict rules', () => {
    // The scan reply schema is the deepest shape a provider requests: nested
    // objects, arrays of objects, optionals at three levels.
    const strict = strictSchema({
      type: 'object',
      required: ['observations', 'examined'],
      properties: {
        observations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'subject'],
            properties: {
              kind: { type: 'string' },
              subject: {
                type: 'object',
                required: ['kind', 'id'],
                properties: { kind: { type: 'string' }, id: { type: 'string' } },
              },
              description: { type: 'string' },
            },
          },
        },
        examined: { type: 'array', items: { type: 'string' } },
      },
    })

    expectStrictObjectNodes(strict)
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
