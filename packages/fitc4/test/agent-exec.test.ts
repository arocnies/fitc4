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
import {
  extractJson,
  finishReply,
  runWithRetry,
  schemaMismatch,
  tailExcerpt,
  withoutRepeats,
} from '../src/agent/exec.ts'
import type { AgentExec, AgentReply } from '../src/agent/exec.ts'
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

// Says why it is stuck, then hangs — the shape of a CLI mid-retry.
const noisySlowBinary = fakeBinary(
  'fake-noisy-slow.cjs',
  'process.stderr.write("retrying request 2 of 5\\n"); setTimeout(() => {}, 30000)\n',
)

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

  test('a hung CLI is killed at the timeout, which names the wait and the knob', async () => {
    const reply = await claudeCli({ binary: slowBinary, timeoutMs: 200 }).run({ prompt: 'x' })

    // A bare "timed out" is a symptom with no fix: the duration says whether
    // the call was slow or the default is too low, and the factory name says
    // where to change it.
    expect(!reply.ok && reply.error).toContain('timed out after 0.2s')
    expect(!reply.ok && reply.error).toContain('raise it with claudeCli({ timeoutMs })')
    // A silent hang has no tail to show, and the error must not pretend it does.
    expect(!reply.ok && reply.error).not.toContain('Its last output')
  })

  test("a timeout shows the CLI's last output — a kill mid-retry has already said why", async () => {
    // A wait long enough that the fake CLI has certainly booted and written
    // its stderr line before the kill; at 200ms the kill can beat node's boot.
    const reply = await claudeCli({ binary: noisySlowBinary, timeoutMs: 1_500 }).run({ prompt: 'x' })

    expect(reply.ok).toBe(false)
    expect(!reply.ok && reply.error).toContain('timed out after 1.5s')
    expect(!reply.ok && reply.error).toContain('Its last output: retrying request 2 of 5')
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

  test('an array-rooted schema travels in an object envelope and is unwrapped on reply', async () => {
    captureTo('codex-envelope.json')
    const schema: JsonObject = {
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
    }
    // Strict mode rejects an array root outright, so the wire schema is a
    // one-key object envelope; the model answers inside it, with the optional
    // key as an explicit null.
    process.env['FAKE_RESULT'] = JSON.stringify({
      items: [{ candidateId: 'c', elementId: 'e', reason: null }],
    })

    const reply = await codexCli({ binary: fakeCodex }).run({ prompt: 'x', schema })

    expect(reply).toMatchObject({ ok: true, value: [{ candidateId: 'c', elementId: 'e' }] })
    if (reply.ok) {
      expect(Array.isArray(reply.value)).toBe(true)
      expect((reply.value as JsonObject[])[0]).not.toHaveProperty('reason')
      // The unwrapped, stripped value passes the provider-side check against
      // the ORIGINAL array-rooted schema.
      expect(schemaMismatch(reply.value, schema)).toBeUndefined()
    }
    const wire = JSON.parse(readCapture().schema ?? '') as JsonObject
    expect(wire['type']).toBe('object')
    expect(wire['required']).toEqual(['items'])
    expectStrictObjectNodes(wire as JsonValue)
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

  test("a hung CLI is killed at the timeout, which names this adapter's knob", async () => {
    const reply = await codexCli({ binary: slowBinary, timeoutMs: 200 }).run({ prompt: 'x' })

    expect(!reply.ok && reply.error).toContain('timed out after 0.2s')
    expect(!reply.ok && reply.error).toContain('raise it with codexCli({ timeoutMs })')
  })
})

/**
 * An unusable CLI must say why, in its own words.
 *
 * These fakes reproduce output captured from both real CLIs run against an
 * empty config directory, so they behave as logged out. Nothing here invokes a
 * real CLI, and nothing here touches anyone's credentials: the shapes are the
 * ground truth, checked in, and the point is that the reader sees the cause.
 * Both CLIs bury it: claude puts it in the last field of a JSON envelope that
 * opens with usage and cost metadata, codex puts it on the last line after a
 * banner and roughly twenty lines of retry spam.
 */
const loggedOutClaude = fakeBinary(
  'fake-claude-logged-out.cjs',
  `
process.stdout.write(
  JSON.stringify({
    is_error: true,
    duration_ms: 812,
    duration_api_ms: 0,
    num_turns: 1,
    stop_reason: 'stop_sequence',
    session_id: '7c2f0f1e-0d1a-4b9e-9d1b-0f4a2c8e1b33',
    total_cost_usd: 0,
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
    permission_denials: [],
    modelUsage: {},
    result: 'Not logged in \\u00b7 Please run /login',
  }),
)
process.exit(1)
`,
)

const loggedOutCodex = fakeBinary(
  'fake-codex-logged-out.cjs',
  `
const lines = [
  'OpenAI Codex v0.146.0',
  '--------',
  'workdir: /tmp/fitc4-agent-7f2a',
  'model: gpt-5.6-luna',
  'provider: openai',
  'approval: never',
  'sandbox: read-only',
  'reasoning effort: none',
  'reasoning summaries: none',
  'session id: 01a0f6d2-1e8c-4f3a-9c21-7b5d0e4a9f11',
  '--------',
]
for (const attempt of [1, 2, 3, 4, 5]) {
  lines.push('failed to connect to websocket: HTTP error: 401 Unauthorized')
  lines.push('ERROR: Reconnecting... ' + attempt + '/5')
}
for (const attempt of [1, 2, 3, 4, 5]) {
  lines.push('failed to connect over https: HTTP error: 401 Unauthorized')
  lines.push('ERROR: Reconnecting... ' + attempt + '/5')
}
lines.push(
  'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, ' +
    'url: https://api.openai.com/v1/responses, cf-ray: 9a1b2c3d4e5f6789-SEA, request id: req_0a1b2c',
)
process.stderr.write(lines.join('\\n') + '\\n')
process.exit(1)
`,
)

describe('an unusable CLI reports its own cause', () => {
  test("claude's envelope is read, not trimmed, and the login command is named", async () => {
    const reply = await claudeCli({ binary: loggedOutClaude }).run({ prompt: 'x' })

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    // The middot is the CLI's own punctuation. Another tool's message travels
    // verbatim; restyling it to this project's conventions would misquote it.
    expect(reply.error).toContain('Not logged in · Please run /login')
    expect(reply.error).toContain("run 'claude login' first")
    // The regression this fixes: the envelope's leading usage and cost
    // metadata used to be the entire message a reader got.
    expect(reply.error).not.toContain('total_cost_usd')
  })

  test("codex's last line survives its banner and its retry spam", async () => {
    const reply = await codexCli({ binary: loggedOutCodex }).run({ prompt: 'x' })

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain('401 Unauthorized: Missing bearer or basic authentication in header')
    expect(reply.error).toContain("run 'codex login' first")
    // The banner used to be the entire message; five identical reconnect
    // lines would crowd out the cause even reading from the end.
    expect(reply.error).not.toContain('OpenAI Codex v0.146.0')
    expect(reply.error.match(/Reconnecting/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  test('a failure that is not about auth gets the cause and no login hint', async () => {
    // A wrong login hint sends the reader down the wrong path, so detection is
    // a short explicit marker list and stays silent when nothing matches.
    const otherClaude = fakeBinary(
      'fake-claude-other-failure.cjs',
      `
process.stdout.write(JSON.stringify({ is_error: true, total_cost_usd: 0, result: 'Credit balance is too low' }))
process.exit(1)
`,
    )
    const claudeReply = await claudeCli({ binary: otherClaude }).run({ prompt: 'x' })
    expect(!claudeReply.ok && claudeReply.error).toContain('Credit balance is too low')
    expect(!claudeReply.ok && claudeReply.error).not.toContain('claude login')

    const otherCodex = fakeBinary(
      'fake-codex-other-failure.cjs',
      `
process.stderr.write(
  'OpenAI Codex v0.146.0\\n--------\\nmodel: nope\\n--------\\n' +
    "ERROR: model 'nope' is not supported by this account\\n",
)
process.exit(1)
`,
    )
    const codexReply = await codexCli({ binary: otherCodex }).run({ prompt: 'x' })
    expect(!codexReply.ok && codexReply.error).toContain("model 'nope' is not supported")
    expect(!codexReply.ok && codexReply.error).not.toContain('codex login')
  })
})

describe('tailExcerpt', () => {
  test('keeps whole lines from the end, announces the dropped head, trims one long line', () => {
    expect(tailExcerpt('banner\nworkdir: /x\nERROR: the cause', 100)).toBe(
      'banner workdir: /x ERROR: the cause',
    )
    // Over budget: the head goes and the drop is announced inline.
    expect(tailExcerpt('aaaaaaaa\nbbbb\ncccc', 10)).toBe('… bbbb cccc')
    // A single line over budget keeps its head, where a message's own subject is.
    expect(tailExcerpt('ERROR: unexpected status 401, request id: req_9', 20)).toBe(
      'ERROR: unexpected st…',
    )
    expect(tailExcerpt('\n  \n', 100)).toBe('')
  })
})

describe('withoutRepeats', () => {
  test('collapses lines that differ only in digits, first occurrence wins', () => {
    const collapsed = withoutRepeats(
      ['retrying 1/5', 'retrying 2/5', 'retrying 3/5', 'ERROR: gave up'].join('\n'),
    )

    expect(collapsed).toBe('retrying 1/5\nERROR: gave up')
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

  // Measured live on a sonnet draft: a description written across two lines
  // put a literal newline inside the JSON string, which is invalid JSON
  // carrying an entirely unambiguous value, and it aborted a 35-element
  // draft. Tab and carriage return travel the same way.
  test('a raw control character inside a string is repaired, not refused', () => {
    expect(extractJson('{"description":"Line one\nline two."}')).toEqual({
      description: 'Line one\nline two.',
    })
    expect(extractJson('{"a":"x\ty\rz"}')).toEqual({ a: 'x\ty\rz' })
    // An already-escaped newline is untouched, so a well-formed reply parses
    // exactly as before rather than through the repair path.
    expect(extractJson('{"a":"one\\ntwo"}')).toEqual({ a: 'one\ntwo' })
    // The repair reads string state honestly: a brace inside a string is
    // content, and the control character after it is still inside that string.
    expect(extractJson('{"a":"{ not a brace\nstill inside"}')).toEqual({
      a: '{ not a brace\nstill inside',
    })
  })

  test('a reply cut off mid-value stays a refusal', () => {
    expect(extractJson('{"description":"This container provisions and orch')).toBeUndefined()
  })
})

// A truncated reply and a badly formatted one both arrive as unparseable, and
// the excerpt in the error is capped, so the message has to distinguish them:
// they have different fixes, and conflating them sent a real debugging session
// chasing the wrong cause.
describe('unparseable reply diagnostics', () => {
  const schema = { type: 'object', required: ['description'], properties: { description: { type: 'string' } } }

  test('a cut-off reply says it ended mid-value', () => {
    const reply = finishReply({ prompt: 'describe', schema }, '{"description":"half a sent')

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain('ended mid-value')
    expect(reply.error).toContain('cut off')
  })

  test('a complete reply that is simply not JSON says only that', () => {
    const reply = finishReply({ prompt: 'describe', schema }, 'I cannot determine that.')

    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain('was not the requested JSON')
    expect(reply.error).not.toContain('ended mid-value')
  })
})

// A defective reply is the one failure a second billed call plausibly fixes,
// measured live: one cut-off describe reply out of 32 aborted a whole draft,
// and the human rerun that followed was exactly one retry. `runWithRetry` is
// that rerun without the human, and it must never spend a second call on a
// failure a retry cannot fix, such as a missing binary or a login problem.
describe('runWithRetry', () => {
  function execReplying(...replies: AgentReply[]): AgentExec & { calls: number } {
    const queue = [...replies]
    const exec = {
      id: 'fake-cli/fake-model',
      calls: 0,
      run: (): Promise<AgentReply> => {
        exec.calls += 1
        const reply = queue.shift()
        if (reply === undefined) throw new Error('ran out of scripted replies')
        return Promise.resolve(reply)
      },
    }
    return exec
  }

  test('a defective first reply gets one retry, and the retry answers', async () => {
    const exec = execReplying(
      { ok: false, error: 'reply ended mid-value', transient: true },
      { ok: true, value: { description: 'whole' }, raw: '{"description":"whole"}' },
    )
    const reply = await runWithRetry(exec, { prompt: 'describe' })
    expect(exec.calls).toBe(2)
    expect(reply.ok).toBe(true)
  })

  test('a non-transient failure is never retried', async () => {
    const exec = execReplying({ ok: false, error: 'claude not found; is it installed?' })
    const reply = await runWithRetry(exec, { prompt: 'describe' })
    expect(exec.calls).toBe(1)
    expect(reply.ok).toBe(false)
  })

  test('a success costs exactly one call', async () => {
    const exec = execReplying({ ok: true, value: 'fine', raw: 'fine' })
    await runWithRetry(exec, { prompt: 'describe' })
    expect(exec.calls).toBe(1)
  })

  test('two defective replies in a row fail, saying the retry happened', async () => {
    const exec = execReplying(
      { ok: false, error: 'reply ended mid-value', transient: true },
      { ok: false, error: 'reply was not the requested JSON', transient: true },
    )
    const reply = await runWithRetry(exec, { prompt: 'describe' })
    expect(exec.calls).toBe(2)
    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.error).toContain('already retried once')
  })
})

// The transient flag is what routes a failure into that retry, so which
// failures carry it is contractual: reply defects do, and finishReply is
// where the shared adapters produce all of them.
describe('transient marking', () => {
  const schema = { type: 'object', required: ['description'], properties: { description: { type: 'string' } } }

  test('a cut-off reply is transient', () => {
    const reply = finishReply({ prompt: 'describe', schema }, '{"description":"half a sent')
    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.transient).toBe(true)
  })

  test('a schema-mismatched reply is transient', () => {
    const reply = finishReply({ prompt: 'describe', schema }, '{}')
    expect(reply.ok).toBe(false)
    if (reply.ok) return
    expect(reply.transient).toBe(true)
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
