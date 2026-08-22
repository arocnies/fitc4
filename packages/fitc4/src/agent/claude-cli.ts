/**
 * The Claude Code CLI adapter.
 *
 * Runs `claude --print` as an isolated one-shot: no user or project settings
 * (`--setting-sources ''`), no MCP servers (`--strict-mcp-config` with none
 * configured), a replaced system prompt, and no tools at all unless the
 * request is agentic, so the reply can only come from the prefilled context.
 *
 * The model defaults to Haiku deliberately: extraction-shaped provider work is
 * high-volume and cheap-model-friendly, and a caller doing judgment-shaped
 * work opts into a stronger model per instance.
 */

import {
  composeInput,
  FAILURE_EXCERPT_LIMIT,
  finishReply,
  runCliProcess,
  truncate,
  withLoginHint,
} from './exec.ts'
import type { AgentExec, AgentReply, AgentRequest } from './exec.ts'

export const DEFAULT_CLAUDE_MODEL = 'haiku'

export interface ClaudeCliOptions {
  /** Model name or alias, e.g. 'haiku', 'sonnet'. Default: cheap. */
  model?: string
  /** Path to the CLI binary. Default: `claude` on PATH. */
  binary?: string
  /** Hard per-call timeout. Default: 120 seconds; a big one-shot scan may need more. */
  timeoutMs?: number
}

const SYSTEM_PROMPT =
  'You are a non-interactive component inside an architecture checker. ' +
  'Answer strictly from the provided context unless tools are available. ' +
  'When a reply format schema is given, output exactly one JSON value matching it and nothing else.'

const READ_ONLY_TOOLS = 'Read,Grep,Glob'

/**
 * The fixed setup the model sees beyond the request: SYSTEM_PROMPT, the
 * isolation flags, and the tool sets above. Bump when any of them changes, so
 * a response cache stops replaying replies recorded against the old setup.
 */
const FINGERPRINT = 'claude-cli/system-prompt-v1/flags-v1'

/** The non-interactive way in. The CLI's own text names the `/login` slash command instead. */
const LOGIN_COMMAND = 'claude login'

/**
 * The real error inside a `--output-format json` envelope.
 *
 * The envelope leads with usage and cost metadata and puts the message last,
 * in `result`, so an excerpt taken off the front shows a reader the token
 * counts and nothing else: a logged-out CLI used to report `total_cost_usd`
 * and hide `Not logged in · Please run /login`. Whatever the field says
 * travels verbatim, punctuation included. It is another tool's message, and
 * restyling it to our own conventions would misquote it.
 *
 * `undefined` when the output is not an envelope or carries no usable field,
 * which drops `runCliProcess` back to the trimmed tail.
 */
function explainEnvelope(output: { stdout: string; stderr: string }): string | undefined {
  let envelope: unknown
  try {
    envelope = JSON.parse(output.stdout)
  } catch {
    return undefined
  }
  const message = (envelope as { result?: unknown }).result
  if (typeof message !== 'string' || message.trim() === '') return undefined
  return truncate(message, FAILURE_EXCERPT_LIMIT)
}

export function claudeCli(options: ClaudeCliOptions = {}): AgentExec {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL
  const binary = options.binary ?? 'claude'
  const defaultTimeoutMs = options.timeoutMs ?? 120_000

  return {
    id: `claude-cli/${model}`,
    fingerprint: FINGERPRINT,
    async run(request: AgentRequest): Promise<AgentReply> {
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
        factory: 'claudeCli',
        explain: explainEnvelope,
        loginCommand: LOGIN_COMMAND,
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

      // An error envelope on a zero exit gets the same treatment as a non-zero
      // one: the message the envelope carries, not the metadata around it.
      const record = envelope as { is_error?: unknown; result?: unknown }
      if (record.is_error === true || typeof record.result !== 'string') {
        const explained =
          explainEnvelope(run.result) ?? truncate(JSON.stringify(envelope), FAILURE_EXCERPT_LIMIT)
        return {
          ok: false,
          error: withLoginHint(
            `${binary} reported an error: ${explained}`,
            run.result.stdout,
            LOGIN_COMMAND,
          ),
        }
      }

      return finishReply(request, record.result)
    },
  }
}
