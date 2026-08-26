/**
 * The scripted stub exec — a "recorded" ideal agent.
 *
 * Each fixture checks in a `replies.json`: the reply a perfect agent would
 * give to each request its providers send. The stub matches an incoming
 * request against those scripts by content (never by call order, so a
 * provider reordering does not silently misroute a reply) and returns the
 * scripted value. This makes the default eval run deterministic, free, and
 * self-testing: a wrong stub score means the fixture, the expectations, or
 * the pipeline wiring broke — not the agent.
 *
 * An unmatched request is a visible `{ ok: false }` failure, which the
 * fail-closed providers turn into a `provider-failure` error and the advisory
 * providers into an `agent-unavailable` finding — either way the scorecard
 * shows it, never a silently skipped call.
 */

import type { JsonValue } from '@arocnies/fitc4'
import type { AgentExec, AgentReply, AgentRequest } from '@arocnies/fitc4/agent'

export interface ScriptedReply {
  /** Every listed condition must hold for the script to match. */
  when: {
    /** Substring the request prompt must contain. */
    promptIncludes?: string
    /**
     * Substring(s) the prefilled context must contain — all of them, when a
     * list. A list is for requests only a conjunction can tell apart: a
     * focused scan under the shipped default instructions shares its
     * instruction text with an agentic whole-repo scan and its focus header
     * with the fixture's own oracle scan, and only both together name it.
     */
    contextIncludes?: string | string[]
  }
  /** The JSON value the ideal agent replies with. */
  reply: JsonValue
}

/** Build an `AgentExec` that answers from a fixture's checked-in scripts. */
export function scriptedExec(fixture: string, replies: ScriptedReply[]): AgentExec {
  return {
    id: 'scripted-stub',
    fingerprint: 'evals/replies-v1',
    async run(request: AgentRequest): Promise<AgentReply> {
      const script = replies.find((entry) => matches(entry.when, request))
      if (script === undefined) {
        return {
          ok: false,
          error:
            `no scripted reply in fixtures/${fixture}/replies.json matches this request ` +
            `(prompt starts: '${request.prompt.slice(0, 80)}…')`,
        }
      }
      return { ok: true, value: script.reply, raw: JSON.stringify(script.reply) }
    },
  }
}

function matches(when: ScriptedReply['when'], request: AgentRequest): boolean {
  if (when.promptIncludes !== undefined && !request.prompt.includes(when.promptIncludes)) {
    return false
  }
  const context = request.context ?? ''
  const needed =
    when.contextIncludes === undefined
      ? []
      : Array.isArray(when.contextIncludes)
        ? when.contextIncludes
        : [when.contextIncludes]
  return needed.every((needle) => context.includes(needle))
}
