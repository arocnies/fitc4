/**
 * The Claude Code CLI adapter.
 *
 * Runs `claude --print` as an isolated one-shot: no user or project settings
 * (`--setting-sources ''`), no MCP servers (`--strict-mcp-config` with none
 * configured), a replaced system prompt, and — unless the request is agentic —
 * no tools at all, so the reply can only come from the prefilled context.
 *
 * The model defaults to Haiku deliberately: extraction-shaped provider work is
 * high-volume and cheap-model-friendly, and a caller doing judgment-shaped
 * work opts into a stronger model per instance.
 */

import { composeInput, finishReply, runCliProcess, truncate } from './exec.ts'
import type { AiExec, AiReply, AiRequest } from './exec.ts'

export const DEFAULT_CLAUDE_MODEL = 'haiku'

export interface ClaudeCliOptions {
  /** Model name or alias, e.g. 'haiku', 'sonnet'. Default: cheap. */
  model?: string
  /** Path to the CLI binary. Default: `claude` on PATH. */
  binary?: string
  timeoutMs?: number
}

const SYSTEM_PROMPT =
  'You are a non-interactive component inside an architecture checker. ' +
  'Answer strictly from the provided context unless tools are available. ' +
  'When a reply format schema is given, output exactly one JSON value matching it and nothing else.'

const READ_ONLY_TOOLS = 'Read,Grep,Glob'

/**
 * The fixed surface the model sees beyond the request: SYSTEM_PROMPT, the
 * isolation flags, and the tool sets above. Bump when any of them changes, so
 * a response cache stops replaying replies recorded against the old surface.
 */
const FINGERPRINT = 'claude-cli/system-prompt-v1/flags-v1'

export function claudeCli(options: ClaudeCliOptions = {}): AiExec {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL
  const binary = options.binary ?? 'claude'
  const defaultTimeoutMs = options.timeoutMs ?? 120_000

  return {
    id: `claude-cli/${model}`,
    fingerprint: FINGERPRINT,
    async run(request: AiRequest): Promise<AiReply> {
      const args = [
        '--print',
        '--output-format',
        'json',
        '--model',
        model,
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--system-prompt',
        SYSTEM_PROMPT,
        '--tools',
        request.agentic === true ? READ_ONLY_TOOLS : '',
      ]

      const run = await runCliProcess(binary, args, {
        stdin: composeInput(request),
        cwd: request.cwd,
        timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
      })
      if (!run.ok) return run

      // `--output-format json` wraps the reply in a result envelope.
      let envelope: unknown
      try {
        envelope = JSON.parse(run.result.stdout)
      } catch {
        return {
          ok: false,
          error: `${binary} printed a malformed envelope: ${truncate(run.result.stdout, 200)}`,
        }
      }

      const record = envelope as { is_error?: unknown; result?: unknown }
      if (record.is_error === true || typeof record.result !== 'string') {
        return { ok: false, error: `${binary} reported an error: ${truncate(JSON.stringify(envelope), 300)}` }
      }

      return finishReply(request, record.result)
    },
  }
}
