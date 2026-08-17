/**
 * The AI execution contract (`fitc4/ai`).
 *
 * An `AiExec` adapts one locally installed agent CLI — the user's own install,
 * login, and billing — into a function providers can call. FitC4 never holds
 * an API key: authentication and model access belong entirely to the CLI.
 *
 * Two modes, one default. With `agentic` unset the tool gets no tools at all
 * and must answer from the prefilled context, which keeps a call cheap,
 * deterministic in its inputs, and cacheable. `agentic: true` permits
 * read-only repository exploration for questions that genuinely need it.
 *
 * A reply is a value, never an exception: adapters return `{ ok: false }` and
 * the calling provider decides what an unavailable or malformed AI means for
 * its findings. Adapters do not retry — a retry is another billed call, and
 * whether one is worth it is the provider's judgment, not the transport's.
 */

import { spawn } from 'node:child_process'

import type { JsonObject, JsonValue } from '../types.ts'

export interface AiRequest {
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

export type AiReply =
  | { ok: true; value: JsonValue; raw: string }
  | { ok: false; error: string }

export interface AiExec {
  /** Stable identity for cache keys and finding provenance; includes the model. */
  id: string
  run(request: AiRequest): Promise<AiReply>
}

/**
 * Compose the single input document an adapter feeds the CLI on stdin.
 *
 * Stdin rather than argv, because context routinely exceeds the argument-size
 * limit — and because one document makes the call reproducible: the same bytes
 * in are the cache key and the whole story of what the model saw.
 */
export function composeInput(request: AiRequest): string {
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

/** Turn a CLI's reply text into an `AiReply`, honouring the requested schema. */
export function finishReply(request: AiRequest, text: string): AiReply {
  if (request.schema === undefined) return { ok: true, value: text, raw: text }

  const value = extractJson(text)
  if (value === undefined) {
    return { ok: false, error: `reply was not the requested JSON: ${truncate(text, 200)}` }
  }
  return { ok: true, value, raw: text }
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
