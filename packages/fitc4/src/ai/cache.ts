/**
 * Response caching for `AiExec`.
 *
 * The cache is what reconciles an AI provider with a deterministic gate: the
 * key is everything the model saw — adapter identity (which carries the
 * model), prompt, context, schema, agentic flag — so a rerun with unchanged
 * inputs replays the recorded reply, byte for byte and for free. Inputs only
 * change when the code or model they were built from changed.
 *
 * Only successes are cached. Caching a failure would pin an outage.
 *
 * `cwd` and `timeoutMs` are deliberately not in the key: neither changes what
 * the model was asked.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { AiExec, AiRequest } from './exec.ts'

export interface CacheOptions {
  /**
   * Cache directory. Default: `node_modules/.cache/fitc4-ai` under the
   * working directory — inside an ignored tree, so nothing lands in git.
   */
  directory?: string
}

export function cached(exec: AiExec, options: CacheOptions = {}): AiExec {
  const directory =
    options.directory ?? path.join(process.cwd(), 'node_modules', '.cache', 'fitc4-ai')

  return {
    id: exec.id,
    async run(request: AiRequest) {
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            exec: exec.id,
            prompt: request.prompt,
            context: request.context ?? null,
            schema: request.schema ?? null,
            agentic: request.agentic ?? false,
          }),
        )
        .digest('hex')
      const file = path.join(directory, `${key}.json`)

      try {
        const hit = JSON.parse(fs.readFileSync(file, 'utf8')) as { value: unknown; raw: string }
        return { ok: true as const, value: hit.value as never, raw: hit.raw }
      } catch {
        // Miss or unreadable entry — either way, ask the real exec.
      }

      const reply = await exec.run(request)
      if (reply.ok) {
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(file, JSON.stringify({ value: reply.value, raw: reply.raw }))
      }
      return reply
    },
  }
}
