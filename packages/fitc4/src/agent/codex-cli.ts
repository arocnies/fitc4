/**
 * The Codex CLI adapter.
 *
 * Runs `codex exec` isolated: ephemeral (no session state), user config and
 * rules ignored, sandbox locked to read-only. Codex has no tool-less mode, so
 * every call is effectively agentic-read-only. The prefilled context is still
 * the primary input, and the sandbox is what bounds the exploring.
 *
 * Codex enforces JSON replies natively through `--output-schema`, so a schema
 * request round-trips through a temp file instead of prompt discipline. The
 * reply is read from `--output-last-message` rather than parsed out of the
 * `--json` event stream.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { JsonObject, JsonValue } from '../types.ts'
import {
  composeInput,
  extractJson,
  FAILURE_EXCERPT_LIMIT,
  finishReply,
  runCliProcess,
  schemaMismatch,
  tailExcerpt,
  truncate,
  withoutRepeats,
} from './exec.ts'
import type { AgentExec, AgentReply, AgentRequest } from './exec.ts'

export interface CodexCliOptions {
  /** Model name; omitted, the CLI's own default applies. */
  model?: string
  /** Path to the CLI binary. Default: `codex` on PATH. */
  binary?: string
  /** Hard per-call timeout. Default: 120 seconds; a big one-shot scan may need more. */
  timeoutMs?: number
}

/**
 * Make a JSON Schema acceptable to OpenAI strict structured output.
 *
 * The endpoint behind `--output-schema` demands, on every object node with
 * `properties`, both `additionalProperties: false` and a `required` array
 * naming EVERY property key. A schema with a genuinely optional property is
 * rejected outright (HTTP 400). Optionality therefore cannot be expressed by
 * omission: each originally-optional property becomes required-but-nullable,
 * in the forms strict mode accepts, `"type": [..., "null"]` for plain typed
 * schemas, `anyOf` with `{ "type": "null" }` for structured ones (strict mode
 * does not accept every JSON Schema form). The model then answers
 * `"reason": null` where the plain schema would let it omit the key;
 * `codexCli` strips those nulls back out before the reply meets the original
 * schema. Callers keep writing plain schemas.
 */
export function strictSchema(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(strictSchema)
  if (node === null || typeof node !== 'object') return node

  const copy: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(node)) {
    // The `properties` map's values are schemas but the map itself is not:
    // recurse one level in by hand so a property named e.g. `required` or
    // `properties` is never mistaken for a schema keyword.
    copy[key] = key === 'properties' ? mapPropertySchemas(value) : strictSchema(value)
  }

  const properties = copy['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    if (copy['additionalProperties'] === undefined) copy['additionalProperties'] = false
    const required = copy['required']
    const originallyRequired = new Set(Array.isArray(required) ? required : [])
    for (const key of Object.keys(properties)) {
      if (!originallyRequired.has(key)) properties[key] = nullable(properties[key] as JsonValue)
    }
    copy['required'] = Object.keys(properties)
  }
  return copy
}

function mapPropertySchemas(map: JsonValue): JsonValue {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return map
  const copy: JsonObject = {}
  for (const [name, schema] of Object.entries(map)) copy[name] = strictSchema(schema)
  return copy
}

const NULLABLE_AS_TYPE_UNION = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** Widen a property schema to also accept null, in the simplest form OpenAI strict mode takes. */
function nullable(schema: JsonValue): JsonValue {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema

  const type = schema['type']
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type]
  if (types.includes('null')) return schema
  if (Array.isArray(schema['anyOf'])) return { ...schema, anyOf: [...schema['anyOf'], { type: 'null' }] }
  if (types.length > 0 && types.every((entry) => typeof entry === 'string' && NULLABLE_AS_TYPE_UNION.has(entry))) {
    return { ...schema, type: [...types, 'null'] }
  }
  // Structured schemas (object/array): strict mode takes the union via anyOf.
  return { anyOf: [schema, { type: 'null' }] }
}

/**
 * Undo strictSchema's optional-as-nullable encoding in a parsed reply.
 *
 * The model answers `"reason": null` where the original schema simply allows
 * the key to be absent, and the provider-side check (`schemaMismatch`) judges
 * the reply against that original schema, so null members on originally
 * OPTIONAL keys are dropped, deeply, guided by the original schema.
 *
 * Assumption this rests on: FitC4 reply schemas never declare an optional
 * property as legitimately nullable, so on an optional key a null can only be
 * strict mode's encoding of omission, so dropping it is safe. A null on a
 * REQUIRED key is kept: it is either a legitimate value (the ownership
 * advisor's `element: ['string', 'null']`) or a model error the schema check
 * must fail visibly.
 */
function withoutNullOptionals(value: JsonValue, schema: JsonValue): JsonValue {
  const node = schema !== null && typeof schema === 'object' && !Array.isArray(schema) ? schema : {}

  if (Array.isArray(value)) {
    const items = node['items'] ?? null
    return value.map((entry) => withoutNullOptionals(entry, items))
  }
  if (value === null || typeof value !== 'object') return value

  const required = new Set(Array.isArray(node['required']) ? node['required'] : [])
  const properties = node['properties']
  const propertySchemas =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties) ? properties : {}

  const copy: JsonObject = {}
  for (const [key, member] of Object.entries(value)) {
    if (member === null && !required.has(key)) continue
    copy[key] = withoutNullOptionals(member, propertySchemas[key] ?? null)
  }
  return copy
}

/**
 * Strict mode's other structural demand: the root schema must be an object.
 * A `type: "array"` at the root is rejected outright (HTTP 400). An array-rooted
 * request schema (agent-resolve's) therefore travels inside a one-key object
 * envelope on the wire, and the reply is unwrapped back to the array before it
 * meets the original schema. The envelope exists only between here and the
 * endpoint: the cache records the unwrapped value.
 */
const ENVELOPE_KEY = 'items'

function isArrayRooted(schema: JsonObject): boolean {
  return schema['type'] === 'array'
}

function envelope(schema: JsonObject): JsonObject {
  return { type: 'object', required: [ENVELOPE_KEY], properties: { [ENVELOPE_KEY]: schema } }
}

/**
 * The fixed setup the model sees beyond the request: the isolation and
 * sandbox flags above, plus the strictSchema transform (and, for array-rooted
 * schemas, the envelope) applied to a requested schema. Bump when that setup
 * changes, so a response cache stops replaying replies recorded against the
 * old one.
 */
const FINGERPRINT = 'codex-cli/flags-v3'

/** The non-interactive way in. The CLI's own failure text offers no advice at all. */
const LOGIN_COMMAND = 'codex login'

/**
 * The tail of codex's output, with its retry spam collapsed first.
 *
 * A logged-out `codex exec` prints a banner (version, workdir, model, sandbox,
 * session id), then roughly twenty lines of reconnect attempts over about ten
 * seconds, then the one line that names the cause. There is no envelope to
 * extract from, so the tail is the answer, but five copies of the same symptom
 * would crowd the cause out of any budget. Hence the collapse, and nothing
 * more: this stays a text tail, never a log parser for a format the CLI is
 * free to change.
 */
function explainCodexOutput(output: { stdout: string; stderr: string }): string | undefined {
  const text = output.stderr || output.stdout
  if (text.trim() === '') return undefined
  return tailExcerpt(withoutRepeats(text), FAILURE_EXCERPT_LIMIT)
}

export function codexCli(options: CodexCliOptions = {}): AgentExec {
  const binary = options.binary ?? 'codex'
  const defaultTimeoutMs = options.timeoutMs ?? 120_000

  return {
    id: `codex-cli/${options.model ?? 'default'}`,
    fingerprint: FINGERPRINT,
    async run(request: AgentRequest): Promise<AgentReply> {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-agent-'))
      try {
        const replyFile = path.join(workDir, 'reply.txt')
        const args = [
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--ignore-rules',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '--color',
          'never',
          '--output-last-message',
          replyFile,
        ]
        if (options.model !== undefined) args.push('--model', options.model)
        if (request.cwd !== undefined) args.push('--cd', request.cwd)
        const enveloped = request.schema !== undefined && isArrayRooted(request.schema)
        if (request.schema !== undefined) {
          const schemaFile = path.join(workDir, 'schema.json')
          const wireSchema = enveloped ? envelope(request.schema) : request.schema
          fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(wireSchema)))
          args.push('--output-schema', schemaFile)
        }
        args.push('-')

        const run = await runCliProcess(binary, args, {
          stdin: composeInput(request),
          cwd: request.cwd,
          timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
          factory: 'codexCli',
          explain: explainCodexOutput,
          loginCommand: LOGIN_COMMAND,
        })
        if (!run.ok) return run

        let reply: string
        try {
          reply = fs.readFileSync(replyFile, 'utf8')
        } catch {
          return { ok: false, error: `${binary} wrote no reply` }
        }
        if (request.schema === undefined) return finishReply(request, reply)

        // The model answered under strictSchema's transform: originally
        // optional keys come back as explicit nulls. Strip them (see
        // withoutNullOptionals) before the reply meets the original schema.
        let value = extractJson(reply)
        if (value === undefined) {
          return { ok: false, error: `reply was not the requested JSON: ${truncate(reply, 200)}` }
        }
        if (enveloped) {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return { ok: false, error: `reply was not the enveloped JSON object: ${truncate(reply, 200)}` }
          }
          value = (value as JsonObject)[ENVELOPE_KEY] ?? null
        }
        const stripped = withoutNullOptionals(value, request.schema)
        const mismatch = schemaMismatch(stripped, request.schema)
        if (mismatch !== undefined) {
          return { ok: false, error: `reply did not match the requested schema: ${mismatch}` }
        }
        return { ok: true, value: stripped, raw: reply }
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true })
      }
    },
  }
}
