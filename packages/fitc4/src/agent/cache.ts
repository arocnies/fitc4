/**
 * Response caching for `AgentExec`.
 *
 * The cache is what reconciles an agent provider with a deterministic gate: the
 * key is everything the model saw — adapter identity (which carries the
 * model), the adapter's `fingerprint` (its fixed prompt-and-flags surface),
 * prompt, context, schema, agentic flag — so a rerun with unchanged inputs
 * replays the recorded reply, byte for byte and for free. Inputs only change
 * when the code or model they were built from changed.
 *
 * Only successes are cached, and a hit is validated the same way a live reply
 * is: a corrupted or off-schema entry is a miss, never a value. Caching a
 * failure would pin an outage; trusting a bad hit would pass a gate on
 * garbage.
 *
 * `cwd` and `timeoutMs` are deliberately not in the key: neither changes what
 * the model was asked.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { schemaMismatch } from './exec.ts'
import type { AgentExec, AgentRequest } from './exec.ts'
import type { JsonValue } from '../types.ts'

export interface CacheOptions {
  /**
   * Cache directory. Default: `node_modules/.cache/fitc4-agent` under the
   * working directory — inside an ignored tree, so nothing lands in git.
   */
  directory?: string
}

export function cached(exec: AgentExec, options: CacheOptions = {}): AgentExec {
  const directory =
    options.directory ?? path.join(process.cwd(), 'node_modules', '.cache', 'fitc4-agent')

  return {
    id: exec.id,
    fingerprint: exec.fingerprint,
    async run(request: AgentRequest) {
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            exec: exec.id,
            fingerprint: exec.fingerprint ?? null,
            prompt: request.prompt,
            context: request.context ?? null,
            schema: request.schema ?? null,
            agentic: request.agentic ?? false,
          }),
        )
        .digest('hex')
      const file = path.join(directory, `${key}.json`)

      // A hit is trusted no further than a live reply would be. A truncated
      // write, a hand-edited file, or an entry recorded before the schema
      // changed shape would otherwise flow into a provider as `undefined` —
      // and a gating provider reading a missing field as absence-of-problem
      // is the gate passing exactly when its judge said nothing.
      const hit = readEntry(file)
      if (hit !== undefined) {
        const mismatch =
          request.schema === undefined ? undefined : schemaMismatch(hit.value, request.schema)
        if (mismatch === undefined) {
          return { ok: true as const, value: hit.value as never, raw: hit.raw }
        }
        // A bad entry is a miss: fall through to the live call, which
        // overwrites it on success.
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

/** A structurally sound cache entry, or undefined — a miss, however it broke. */
function readEntry(file: string): { value: JsonValue; raw: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const entry = parsed as { value?: unknown; raw?: unknown }
  if (typeof entry.raw !== 'string' || !('value' in entry)) return undefined
  return { value: entry.value as JsonValue, raw: entry.raw }
}
