/**
 * The Codex CLI adapter.
 *
 * Runs `codex exec` isolated: ephemeral (no session state), user config and
 * rules ignored, sandbox locked to read-only. Codex has no tool-less mode, so
 * every call is effectively agentic-read-only — the prefilled context is still
 * the primary input, the sandbox is what bounds the exploring.
 *
 * Codex enforces JSON replies natively through `--output-schema`, so a schema
 * request round-trips through a temp file instead of prompt discipline. The
 * reply is read from `--output-last-message` rather than parsed out of the
 * `--json` event stream.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { JsonValue } from '../types.ts'
import { composeInput, finishReply, runCliProcess } from './exec.ts'
import type { AgentExec, AgentReply, AgentRequest } from './exec.ts'

export interface CodexCliOptions {
  /** Model name; omitted, the CLI's own default applies. */
  model?: string
  /** Path to the CLI binary. Default: `codex` on PATH. */
  binary?: string
  timeoutMs?: number
}

/**
 * Make a JSON Schema acceptable to strict structured output.
 *
 * The OpenAI endpoint behind `--output-schema` rejects any object schema that
 * does not pin `additionalProperties: false`, so it is pinned on every object
 * node that leaves it open. Callers keep writing plain schemas.
 */
export function strictSchema(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(strictSchema)
  if (node === null || typeof node !== 'object') return node

  const copy: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(node)) copy[key] = strictSchema(value)
  if (copy['properties'] !== undefined && copy['additionalProperties'] === undefined) {
    copy['additionalProperties'] = false
  }
  return copy
}

/**
 * The fixed surface the model sees beyond the request: the isolation and
 * sandbox flags above. Bump when they change, so a response cache stops
 * replaying replies recorded against the old surface.
 */
const FINGERPRINT = 'codex-cli/flags-v1'

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
        if (request.schema !== undefined) {
          const schemaFile = path.join(workDir, 'schema.json')
          fs.writeFileSync(schemaFile, JSON.stringify(strictSchema(request.schema)))
          args.push('--output-schema', schemaFile)
        }
        args.push('-')

        const run = await runCliProcess(binary, args, {
          stdin: composeInput(request),
          cwd: request.cwd,
          timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
        })
        if (!run.ok) return run

        let reply: string
        try {
          reply = fs.readFileSync(replyFile, 'utf8')
        } catch {
          return { ok: false, error: `${binary} wrote no reply` }
        }
        return finishReply(request, reply)
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true })
      }
    },
  }
}
