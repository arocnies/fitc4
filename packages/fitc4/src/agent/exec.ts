/**
 * The agent execution contract (`@arocnies/fitc4/agent`).
 *
 * An `AgentExec` adapts one locally installed agent CLI into a function
 * providers can call, on the user's own install, login, and billing. FitC4
 * never holds an API key: authentication and model access belong entirely to
 * the CLI.
 *
 * Two modes, one default. With `agentic` unset the tool gets no tools at all
 * and must answer from the prefilled context, which keeps a call cheap,
 * deterministic in its inputs, and cacheable. `agentic: true` permits
 * read-only repository exploration for questions that genuinely need it.
 *
 * A reply is a value, never an exception: adapters return `{ ok: false }` and
 * the calling provider decides what an unavailable CLI or malformed reply
 * means for its findings. Adapters do not retry. A retry is another billed
 * call, and whether one is worth it is the provider's judgment, not the
 * transport's.
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
   * Names the fixed setup the model sees beyond the request itself: a
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
 * limit. One document also makes the call reproducible: the same bytes in are
 * the cache key and the whole story of what the model saw.
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
 * `undefined` means no JSON was found, which is distinct from a parsed `null`.
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
  // shape, say `{}` where `matches` was required, would otherwise flow into a
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
 * Deliberately a small hand-rolled subset of `type`, `properties`, `required`,
 * `items`, and `enum`, matching what provider reply schemas actually use, rather
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

/**
 * How much of a failing CLI's output one error message carries.
 *
 * One budget shared by every failure path, so a reader gets the same amount of
 * evidence whichever path produced the message.
 */
export const FAILURE_EXCERPT_LIMIT = 300

/**
 * Turn a failed CLI's captured output into the human-meaningful error.
 *
 * An adapter supplies one when its CLI's output has a known machine-readable
 * shape, because extracting the field that carries the message beats trimming
 * bytes off a blob. Returning `undefined` means the output was not that shape,
 * and `runCliProcess` falls back to the trimmed tail.
 */
export type CliExplain = (output: { stdout: string; stderr: string }) => string | undefined

/**
 * The informative END of a CLI's output, collapsed onto one line.
 *
 * The head of a failing CLI's output is a banner: version, working directory,
 * model, session id, usage counters. The cause is last. Trimming the first N
 * bytes therefore shows a reader everything except the reason, which is the
 * whole complaint this function answers, and it is general rather than
 * auth-specific: any CLI that prints a banner had its real error trimmed away.
 * So the excerpt grows backwards from the end, whole non-empty lines at a
 * time, until the budget is spent, and a dropped head is announced. Within a
 * single line the head is the informative part (`ERROR: unexpected status 401
 * Unauthorized` before a request id), so one over-budget line is trimmed from
 * its end exactly like `truncate` does.
 */
export function tailExcerpt(text: string, limit: number): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return ''

  const kept: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    const cost = kept.length === 0 ? line.length : line.length + 1
    if (used + cost > limit) break
    kept.unshift(line)
    used += cost
  }
  if (kept.length === 0) return truncate(lines.at(-1) ?? '', limit)

  const dropped = lines.length - kept.length
  return dropped > 0 ? `… ${kept.join(' ')}` : kept.join(' ')
}

/**
 * Collapse repeated lines, counting two lines the same when they differ only
 * in digits.
 *
 * A CLI that retries prints one line per attempt (`Reconnecting... 1/5`
 * through `5/5`, each preceded by the same connection error), and five copies
 * of a symptom crowd the one line that names the cause out of any excerpt.
 * First occurrence wins and order is preserved, so the real error still lands
 * last. Digit-insensitive rather than a log parser: attempt counters, elapsed
 * times, and ids are what vary between otherwise identical lines, and what a
 * CLI's log format means is its own business, not ours to model.
 */
export function withoutRepeats(text: string): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const key = line.trim().replace(/\d+/g, '#')
    if (key !== '' && seen.has(key)) continue
    seen.add(key)
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * The markers that make a failure look like an auth failure.
 *
 * Ground truth from probing both CLIs logged out: claude answers `Not logged
 * in · Please run /login`, codex answers `unexpected status 401 Unauthorized:
 * Missing bearer or basic authentication in header`. Deliberately a short
 * explicit list rather than a heuristic, because a login hint on an unrelated
 * failure sends the reader down the wrong path. The status code is matched at
 * word boundaries so a line number or a byte count named 401 does not read as
 * a login problem.
 */
const AUTH_MARKERS = [
  /not logged in/i,
  /please run \/login/i,
  /\b401\b/,
  /unauthorized/i,
  /missing bearer/i,
]

/** True when a CLI's output carries one of the `AUTH_MARKERS`. */
export function looksLikeAuthFailure(output: string): boolean {
  return AUTH_MARKERS.some((marker) => marker.test(output))
}

/**
 * Append the login command when the failure looks like an auth failure.
 *
 * `output` is the FULL captured output, never the trimmed excerpt, so a cause
 * that display dropped is still detected. Each adapter names its own command
 * because neither CLI's own text offers non-interactive advice: claude points
 * at the interactive `/login` slash command, and codex says nothing actionable
 * at all. Nothing is appended when nothing matches.
 */
export function withLoginHint(
  error: string,
  output: string,
  loginCommand: string | undefined,
): string {
  if (loginCommand === undefined || !looksLikeAuthFailure(output)) return error
  return `${error}; this looks like an auth failure, run '${loginCommand}' first`
}

/** A duration for a human: `120s`, `0.2s`, never `120000ms`. */
function seconds(milliseconds: number): string {
  const value = milliseconds / 1000
  return `${Number.isInteger(value) ? value : Number(value.toFixed(1))}s`
}

interface ProcessResult {
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
function runProcess(
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
 * Run an agent CLI and fold every transport-level failure into the adapters'
 * shared `{ ok: false }` shape: spawn error, timeout, non-zero exit.
 * On success the caller still owns interpreting the output.
 *
 * `factory` names the exported adapter factory whose `timeoutMs` option
 * governs this call. A timeout that reports neither how long it waited nor
 * which knob changes it leaves the reader with a symptom and no fix, and the
 * default is documented nowhere they are looking.
 *
 * `explain` and `loginCommand` are the adapter's contribution to a legible
 * failure, and they apply on the failure paths only: a successful run's output
 * belongs to the caller to interpret.
 */
export async function runCliProcess(
  binary: string,
  args: string[],
  options: {
    stdin?: string
    cwd?: string
    timeoutMs: number
    factory: string
    /** Extracts this CLI's real error from its captured output; see `CliExplain`. */
    explain?: CliExplain
    /** The non-interactive command that logs this CLI in, e.g. `claude login`. */
    loginCommand?: string
  },
): Promise<{ ok: true; result: ProcessResult } | { ok: false; error: string }> {
  let result: ProcessResult
  try {
    result = await runProcess(binary, args, options)
  } catch (error) {
    return { ok: false, error: `${binary}: ${messageOf(error)}` }
  }

  // Both failure paths read the whole capture for the auth hint, the timeout
  // included: a CLI killed mid-retry has already printed why it was retrying,
  // and "timed out after 10s" alone would hide a login problem behind a
  // symptom that looks like slowness.
  const captured = `${result.stdout}\n${result.stderr}`

  if (result.timedOut) {
    return {
      ok: false,
      error: withLoginHint(
        `${binary} timed out after ${seconds(options.timeoutMs)}; ` +
          `raise it with ${options.factory}({ timeoutMs })`,
        captured,
        options.loginCommand,
      ),
    }
  }
  if (result.code !== 0) {
    // stderr first, as before: a CLI that says anything on stderr is saying
    // why it failed. The tail rather than the head, because that is where the
    // reason is.
    const explained = options.explain?.(result)
    const excerpt = explained ?? tailExcerpt(result.stderr || result.stdout, FAILURE_EXCERPT_LIMIT)
    return {
      ok: false,
      error: withLoginHint(
        `${binary} exited ${result.code}: ${excerpt}`,
        captured,
        options.loginCommand,
      ),
    }
  }
  return { ok: true, result }
}
