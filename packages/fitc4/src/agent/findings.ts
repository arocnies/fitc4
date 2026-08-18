/**
 * Shared pieces of the agent validate providers.
 *
 * The contract that reconciles a nondeterministic model with a deterministic
 * gate: agent findings are additive — nothing here can suppress or rewrite a
 * deterministic finding — and each provider's `severity` option says how
 * load-bearing its judgment is. The defaults are advisory; `'error'` is the
 * user's explicit act of making the agent part of the gate.
 *
 * Choosing `'error'` changes the failure semantics on purpose: a gating
 * provider whose CLI is missing, or whose inputs were truncated, must fail the
 * build — otherwise the gate passes exactly when its judge is absent, the
 * fail-open this tool exists to prevent. Advisory providers degrade to a
 * visible nudge instead.
 */

import fs from 'node:fs'
import path from 'node:path'

import { findingId } from '../ids.ts'
import { normalizeSources, SOURCES_KEY } from '../model.ts'
import type { Finding, LikeC4Model, Severity } from '../types.ts'

/**
 * The one finding an agent provider emits when its exec fails.
 *
 * Advisory providers report a `warning` — a logged-out CLI must not fail the
 * build on behalf of a suggestion, but an enrichment that quietly stopped
 * running would look identical to a clean report. A gating provider escalates
 * to `error`: its absence is a hole in the gate, not a missing nicety.
 */
export function agentUnavailable(
  provider: string,
  execId: string,
  error: string,
  severity: Severity,
): Finding {
  return {
    id: findingId(provider, 'agent-unavailable', execId),
    ruleId: 'agent-unavailable',
    severity: severity === 'error' ? 'error' : 'warning',
    description: `Agent assistance was unavailable (${execId}): ${error}`,
    subject: { kind: 'provider', id: provider },
    provider,
  }
}

/**
 * Reported truncation — a silent cap would read as full coverage. Escalates
 * for a gating provider: inputs it never judged are inputs that bypassed it.
 */
export function agentTruncated(
  provider: string,
  dropped: number,
  what: string,
  severity: Severity,
): Finding {
  return {
    id: findingId(provider, 'agent-truncated', what),
    ruleId: 'agent-truncated',
    severity: severity === 'error' ? 'error' : 'info',
    description: `${dropped} ${what} beyond the configured limit were not reviewed.`,
    subject: { kind: 'provider', id: provider },
    provider,
  }
}

/**
 * A plain-text description off a LikeC4 element.
 *
 * LikeC4 stores descriptions as a string or a `{ txt | md }` wrapper depending
 * on authoring form, so both are accepted.
 */
export function elementText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    const wrapper = value as { txt?: unknown; md?: unknown }
    if (typeof wrapper.txt === 'string') return wrapper.txt
    if (typeof wrapper.md === 'string') return wrapper.md
  }
  return undefined
}

/** One line per element: id, title, description, declared sources. */
export function elementCatalog(model: LikeC4Model): string {
  const lines: string[] = ['### Elements in the architecture model']
  for (const element of model.elements()) {
    const description = elementText(element.description) ?? 'no description'
    const sources = normalizeSources(element.metadata[SOURCES_KEY])
    const owns = sources.length > 0 ? ` — owns ${sources.join(', ')}` : ''
    lines.push(`- ${element.id} ('${element.title}'): ${description}${owns}`)
  }
  return lines.join('\n')
}

/** Fenced excerpts of the named files, each capped at `excerptChars`. */
export function fileExcerpts(
  repositoryRoot: string,
  files: string[],
  excerptChars: number,
): string {
  const parts: string[] = []
  for (const relative of files) {
    let excerpt: string
    try {
      const content = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
      excerpt =
        content.length <= excerptChars ? content : `${content.slice(0, excerptChars)}\n… truncated`
    } catch {
      excerpt = '(unreadable)'
    }
    parts.push(`### ${relative}\n\`\`\`\n${excerpt}\n\`\`\``)
  }
  return parts.join('\n\n')
}
