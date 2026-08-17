/**
 * Shared pieces of the AI validate providers.
 *
 * The contract that keeps a nondeterministic model compatible with a
 * deterministic gate: AI findings are additive and severity-capped. Nothing
 * here can suppress or rewrite a deterministic finding, and a provider's
 * `maxSeverity` bounds how loud its judgment may get — advisory unless the
 * user explicitly opts a provider into gating.
 */

import fs from 'node:fs'
import path from 'node:path'

import { findingId } from '../ids.ts'
import { normalizeSources, SOURCES_KEY } from '../model.ts'
import { SEVERITIES } from '../types.ts'
import type { Finding, LikeC4Model, Severity } from '../types.ts'

/** Cap a severity: an AI finding may be at most as severe as `max`. */
export function clampSeverity(severity: Severity, max: Severity): Severity {
  return SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(max) ? max : severity
}

/**
 * The one finding an AI provider emits when its exec fails.
 *
 * A finding rather than a throw, because `provider-failure` is an `error` and
 * a missing or logged-out CLI must not fail the build on behalf of an advisory
 * provider. A finding rather than silence, because an enrichment that quietly
 * stopped running looks identical to a clean report.
 */
export function aiUnavailable(
  provider: string,
  execId: string,
  error: string,
  maxSeverity: Severity,
): Finding {
  return {
    id: findingId(provider, 'ai-unavailable', execId),
    ruleId: 'ai-unavailable',
    severity: clampSeverity('warning', maxSeverity),
    description: `AI assistance was unavailable (${execId}): ${error}`,
    subject: { kind: 'provider', id: provider },
    provider,
  }
}

/** Reported truncation — a silent cap would read as full coverage. */
export function aiTruncated(
  provider: string,
  dropped: number,
  what: string,
  maxSeverity: Severity,
): Finding {
  return {
    id: findingId(provider, 'ai-truncated', what),
    ruleId: 'ai-truncated',
    severity: clampSeverity('info', maxSeverity),
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
