/**
 * The agent execution contract (`fitc4/agent`).
 *
 * An `AgentExec` adapts one locally installed agent CLI — the user's own install,
 * login, and billing — into a function providers can call. FitC4 never holds
 * an API key: authentication and model access belong entirely to the CLI.
 *
 * Two modes, one default. With `agentic` unset the tool gets no tools at all
 * and must answer from the prefilled context, which keeps a call cheap,
 * deterministic in its inputs, and cacheable. `agentic: true` permits
 * read-only repository exploration for questions that genuinely need it.
 *
 * A reply is a value, never an exception: adapters return `{ ok: false }` and
 * the calling provider decides what an unavailable CLI or malformed reply
 * means for its findings. Adapters do not retry — a retry is another billed call, and
 * whether one is worth it is the provider's judgment, not the transport's.
 */

import { spawn } from 'node:child_process'

import { messageOf } from '../errors.ts'
import type { JsonObject, JsonValue } from '../types.ts'

export interface AgentRequest {
  /** The task, stated imperatively. */
  prompt: string
  /** Prefilled context the tool must treat as its entire world. */
  context?: string
  /** JSON Schema the reply must satisfy; the adapter enforces JSON-only output. */
  schema?: JsonObject
  /** Permit read-only repository exploration. Default: no tools at all. */
  agentic?: boolean
  /** Working directory for the subprocess; the repository root in providers. */
  cwd?: string
  timeoutMs?: number
}

export type AgentReply =
  | { ok: true; value: JsonValue; raw: string }
  | { ok: false; error: string }

export interface AgentExec {
  /** Stable identity for cache keys and finding provenance; includes the model. */
  id: string
  /**
   * Names the fixed surface the model sees beyond the request itself — a
   * baked-in system prompt, tool flags, isolation switches. A response cache
   * folds it into the key, so an adapter that changes what it puts in front of
   * the model bumps this string instead of replaying stale replies.
   */
  readonly fingerprint?: string
  run(request: AgentRequest): Promise<AgentReply>
}

/**
 * Compose the single input document an adapter feeds the CLI on stdin.
 *
 * Stdin rather than argv, because context routinely exceeds the argument-size
 * limit — and because one document makes the call reproducible: the same bytes
 * in are the cache key and the whole story of what the model saw.
 */
export function composeInput(request: AgentRequest): string {
  const parts: string[] = []
  if (request.context !== undefined && request.context !== '') {
    parts.push(`## Context\n\n${request.context}`)
  }
  if (request.schema !== undefined) {
    parts.push(
      '## Reply format\n\nReply with a single JSON value matching this JSON Schema and ' +
        `nothing else — no prose, no code fences:\n\n${JSON.stringify(request.schema)}`,
    )
  }
  parts.push(`## Task\n\n${request.prompt}`)
  return parts.join('\n\n')
}

/**
 * Pull one JSON value out of a model reply.
 *
 * Models fence and preface JSON no matter how firmly they are told not to, so
 * this strips a fence and, failing that, parses the outermost bracketed span.
 * `undefined` means no JSON was found — distinct from a parsed `null`.
 */
export function extractJson(text: string): JsonValue | undefined {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  try {
    return JSON.parse(unfenced) as JsonValue
  } catch {
    const start = unfenced.search(/[[{]/)
    const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1)) as JsonValue
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

/** Turn a CLI's reply text into an `AgentReply`, honouring the requested schema. */
export function finishReply(request: AgentRequest, text: string): AgentReply {
  if (request.schema === undefined) return { ok: true, value: text, raw: text }

  const value = extractJson(text)
  if (value === undefined) {
    return { ok: false, error: `reply was not the requested JSON: ${truncate(text, 200)}` }
  }

  // Parsing is not conforming. A reply that is JSON but not the requested
  // shape — `{}` where `matches` was required — would otherwise flow into a
  // provider as a value, and a gating provider reading a missing field as
  // absence-of-problem is the gate passing exactly when its judge mumbled.
  const mismatch = schemaMismatch(value, request.schema)
  if (mismatch !== undefined) {
    return { ok: false, error: `reply did not match the requested schema: ${mismatch}` }
  }
  return { ok: true, value, raw: text }
}

/**
 * First structural mismatch between a value and a JSON Schema, or undefined.
 *
 * Deliberately a small hand-rolled subset — `type`, `properties`, `required`,
 * `items`, `enum` — matching what provider reply schemas actually use, rather
 * than a schema-validator dependency. Keywords outside the subset are ignored,
 * so an exotic schema degrades to a laxer check, never a false rejection.
 */
export function schemaMismatch(value: JsonValue, schema: JsonObject, at = '$'): string | undefined {
  const allowed = schema['enum']
  if (Array.isArray(allowed) && !allowed.some((entry) => entry === value)) {
    return `${at} must be one of ${JSON.stringify(allowed)}`
  }

  const type = schema['type']
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some((entry) => typeof entry === 'string' && matchesType(value, entry))) {
      return `${at} must have type ${types.join(' | ')}, got ${typeNameOf(value)}`
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const required = schema['required']
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) return `${at} is missing '${key}'`
      }
    }
    const properties = schema['properties']
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        const child = value[key]
        if (child === undefined) continue
        if (propertySchema === null || typeof propertySchema !== 'object') continue
        const mismatch = schemaMismatch(child, propertySchema as JsonObject, `${at}.${key}`)
        if (mismatch !== undefined) return mismatch
      }
    }
  }

  if (Array.isArray(value)) {
    const items = schema['items']
    if (items !== null && typeof items === 'object' && !Array.isArray(items)) {
      for (const [index, entry] of value.entries()) {
        const mismatch = schemaMismatch(entry, items as JsonObject, `${at}[${index}]`)
        if (mismatch !== undefined) return mismatch
      }
    }
  }

  return undefined
}

function matchesType(value: JsonValue, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    default:
      return typeof value === type
  }
}

function typeNameOf(value: JsonValue): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

export function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a subprocess with stdin, a hard timeout, and captured output.
 *
 * SIGKILL rather than SIGTERM on timeout: an agent CLI mid-request may trap
 * SIGTERM to save session state, and a hung provider must not hang the gate.
 */
export function runProcess(
  binary: string,
  args: string[],
  options: { stdin?: string; cwd?: string; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })

    // The tool may exit before reading its stdin; that is its answer, not an error.
    child.stdin.on('error', () => {})
    child.stdin.end(options.stdin ?? '')
  })
}

/**
 * Run an agent CLI and fold every transport-level failure — spawn error,
 * timeout, non-zero exit — into the adapters' shared `{ ok: false }` shape.
 * On success the caller still owns interpreting the output.
 */
export async function runCliProcess(
  binary: string,
  args: string[],
  options: { stdin?: string; cwd?: string; timeoutMs: number },
): Promise<{ ok: true; result: ProcessResult } | { ok: false; error: string }> {
  let result: ProcessResult
  try {
    result = await runProcess(binary, args, options)
  } catch (error) {
    return { ok: false, error: `${binary}: ${messageOf(error)}` }
  }

  if (result.timedOut) {
    return { ok: false, error: `${binary} timed out` }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      error: `${binary} exited ${result.code}: ${truncate(result.stderr || result.stdout, 300)}`,
    }
  }
  return { ok: true, result }
}
