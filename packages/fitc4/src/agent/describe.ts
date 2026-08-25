/**
 * The draft describer (`@arocnies/fitc4/agent`).
 *
 * Builds the `describe` callback `draft()` accepts: per eligible element, one
 * one-shot exec call that proposes a one-or-two-sentence description from the
 * files the element owns. The draft stays a draft to rewrite. The describer
 * only ever proposes description text, at draft time, and the gate never
 * rewrites a description; `agentSemanticReview` only critiques one.
 *
 * Abstention and failure are kept apart, permanently, because collapsing them
 * hid the most common first-run problem there is. A logged-out CLI used to
 * produce "kept the TODO" per element and "described 0 of 11", exit 0, which
 * reads as eleven models declining to answer rather than as one CLI that never
 * ran. So a schema-conforming reply with an empty or non-string description is
 * an abstention and returns `undefined`, keeping the element's TODO, while
 * every transport failure (spawn error, not logged in, non-zero exit, timeout,
 * off-schema reply) throws and aborts the draft. A placeholder description is
 * an honest state. A draft that quietly kept every placeholder because nothing
 * was ever asked is not.
 *
 * Each request is a context pack over the element's owned files, so the same
 * attestation rules hold as everywhere else: truncation is announced inline,
 * and the deterministic context composes with `cached()` unchanged, making a
 * redrafted repository re-describe only the elements whose files changed.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { DraftDescribe, DraftElementFacts } from '../draft.ts'
import type { JsonObject } from '../types.ts'
import { assemblePack, fencedExcerpt } from './context-pack.ts'
import type { AgentExec } from './exec.ts'

export interface DraftDescriberOptions {
  exec: AgentExec
  /** Repository root the owned-file paths are relative to. Default: the working directory. */
  repositoryRoot?: string
  /** Byte budget for one element's context pack. */
  budgetBytes?: number
  /** Owned files excerpted per element, in path order; the rest are announced. */
  maxFiles?: number
  /** Characters of each file shown to the model, code-first. */
  excerptChars?: number
}

/**
 * A budget of its own, smaller than `DEFAULT_PACK_BUDGET_BYTES`: a draft
 * makes one call per eligible element, so an element's context is sized for
 * "what is this responsible for", not for a full semantic review.
 */
const DEFAULT_DESCRIBE_BUDGET_BYTES = 16_000

const DEFAULT_MAX_FILES = 6
const DEFAULT_EXCERPT_CHARS = 1_500

const REPLY_SCHEMA: JsonObject = {
  type: 'object',
  required: ['description'],
  properties: {
    description: { type: 'string' },
  },
}

/** Build the `describe` callback for `draft()` from an agent exec. */
export function draftDescriber(options: DraftDescriberOptions): DraftDescribe {
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  const budgetBytes = options.budgetBytes ?? DEFAULT_DESCRIBE_BUDGET_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const excerptChars = options.excerptChars ?? DEFAULT_EXCERPT_CHARS

  return async (element: DraftElementFacts): Promise<string | undefined> => {
    const request =
      element.children !== undefined && element.children.length > 0
        ? containerRequest(element)
        : element.declared === undefined
          ? undefined
          : fileRequest(element, element.declared)
    // Nothing to describe from is an abstention, not a call: no files, no
    // children, no claim means no facts a model could answer over.
    if (request === undefined) return undefined

    const reply = await options.exec.run({
      ...request,
      schema: REPLY_SCHEMA,
      cwd: repositoryRoot,
    })

    // A transport failure is not an abstention. It aborts the draft, carrying
    // the exec id and whatever the adapter said, which is where "not logged
    // in" actually lives.
    if (!reply.ok) {
      throw new Error(`${options.exec.id} could not run: ${reply.error}`)
    }

    const description = (reply.value as { description?: unknown }).description
    if (typeof description !== 'string') return undefined

    // LikeC4 descriptions here are single-line strings, so whitespace runs and
    // newlines collapse; an all-whitespace proposal is no proposal.
    const flattened = description.replace(/\s+/g, ' ').trim()
    return flattened === '' ? undefined : flattened
  }

  /**
   * A pure container's request: zero file reads, because the pass already
   * paid for its children. The children arrive deepest-wave-first (see
   * `describeElements`), so their descriptions here are the settled ones,
   * and a child that abstained shows as exactly that rather than as blank.
   */
  function containerRequest(element: DraftElementFacts): { prompt: string; context: string } {
    const children = element.children ?? []
    const listing = children
      .map(
        (child) =>
          `- ${child.name} (app.${child.path}): ${child.description ?? 'no description yet'}`,
      )
      .join('\n')
    return {
      prompt:
        `The context lists the child elements of ${element.name} (app.${element.path}), a ` +
        'container element of a drafted architecture model that owns no files of its own. ' +
        'Write one or two plain sentences stating what this container as a whole is ' +
        'responsible for, synthesized from what its children do. State durable ' +
        'responsibility: what this part of the system provides to the rest, and why ' +
        'something else would depend on it. Do not enumerate the children, do not restate ' +
        'the container name as if it were a responsibility, and do not speculate beyond ' +
        'what the children support: if they say little, say only that little.',
      context:
        `### Container: ${element.name} (app.${element.path})\n` +
        `Child elements (${children.length}):\n${listing}`,
    }
  }

  function fileRequest(
    element: DraftElementFacts,
    declared: string,
  ): { prompt: string; context: string } {
    const excerpted = element.ownedFiles.slice(0, maxFiles)
    // A fragment element's owned file is the whole containing file, but its
    // subject is one section of it, and a head-of-file excerpt routinely
    // misses that section entirely. Measured on the first live run: a compose
    // stack's fragment elements each saw the file header and the first
    // service, and the honest models could only reply "cannot be determined".
    // So a fragment claim anchors the excerpt at the fragment instead.
    const anchor = fragmentAnchor(declared)
    const pack = assemblePack(
      [
        {
          header:
            `### Drafted element: ${element.name} (app.${element.path})\n` +
            `Declared sources claim: ${declared}\n` +
            `Owned files (${element.ownedFiles.length}):\n` +
            element.ownedFiles.map((file) => `- ${file}`).join('\n'),
          items: [],
          what: 'element facts',
        },
        {
          header:
            anchor === undefined
              ? '### Owned-file excerpts (code-first)'
              : '### Owned-file excerpts (anchored at the claimed fragment)',
          items: excerpted.map(
            (file) =>
              `### ${file}\n${
                anchor === undefined
                  ? fencedExcerpt(repositoryRoot, file, excerptChars)
                  : anchoredExcerpt(repositoryRoot, file, anchor, excerptChars)
              }`,
          ),
          what: `owned files of app.${element.path}`,
          alreadyDropped: element.ownedFiles.length - excerpted.length,
        },
      ],
      budgetBytes,
    )

    // The claim rides in the prompt so the request is self-describing: the
    // cache key, a recorded eval reply, and a human reading a transcript can
    // all tell which element was being described.
    return {
      prompt:
        `The context shows one element of a drafted architecture model: ` +
        `${element.name}, claiming '${declared}'. Write one or two plain sentences ` +
        'stating what this component is responsible for, based only on the files shown. ' +
        'State durable responsibility: what this element does for the rest of the system, ' +
        'and why something else would depend on it. Leave out configuration that can change ' +
        'without the responsibility changing, such as ports, hostnames, environment ' +
        'variables, image tags, and file layout. Do not restate the element name or its ' +
        'technology as if it were a responsibility, and do not speculate beyond the files ' +
        'shown: if they support little, say only that little.',
      context: pack.text,
    }
  }
}

/**
 * The last dot-segment of a fragment claim, or undefined for a plain claim.
 *
 * `docker/docker-compose.yml#services.auth` anchors on `auth`: the last
 * segment names the thing itself, and the leading segments name the path a
 * reader took to it, which the excerpt window's surrounding lines already
 * show. An empty final segment (a trailing dot) yields no anchor rather than
 * an anchor that matches everything.
 */
function fragmentAnchor(declared: string): string | undefined {
  const hash = declared.indexOf('#')
  if (hash <= 0 || hash === declared.length - 1) return undefined
  const segment = declared.slice(hash + 1).split('.').at(-1) ?? ''
  return segment === '' ? undefined : segment
}

/**
 * A fenced excerpt of one file starting at the claimed fragment.
 *
 * The window begins at the first line containing the anchor, so the fragment's
 * own definition is what the model reads instead of whatever happens to sit at
 * the head of the file. The anchoring is announced inline, and so is the
 * fallback: an anchor the file does not contain drops back to the code-first
 * head with a note saying so, because a model told it is looking at the
 * fragment while it is not would describe the wrong thing with confidence.
 */
function anchoredExcerpt(
  repositoryRoot: string,
  relative: string,
  anchor: string,
  excerptChars: number,
): string {
  let content: string
  try {
    content = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
  } catch {
    return '```\n(unreadable)\n```'
  }

  const lines = content.split('\n')
  // Prefer the line that defines the fragment over one that merely mentions
  // it: in a compose file the first occurrence of `db` is routinely another
  // service's depends_on entry, and a window opened there describes the
  // referrer, not the fragment. Measured on the live run: the thin
  // descriptions were exactly the services whose first mention was a
  // reference. A candidate line starts with the anchor at a word boundary,
  // and among candidates the shallowest indentation wins, because references
  // nest inside other definitions (a mapping-form depends_on entry also
  // starts with the anchor, but deeper than the definition). Any mention is
  // the fallback.
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith(anchor)) return false
      const next = trimmed.charAt(anchor.length)
      return next === '' || !/[A-Za-z0-9_-]/.test(next)
    })
  let definition = -1
  for (const candidate of candidates) {
    const depth = candidate.line.length - candidate.line.trimStart().length
    const best = definition === -1 ? undefined : lines[definition]
    const bestDepth = best === undefined ? Infinity : best.length - best.trimStart().length
    if (depth < bestDepth) definition = candidate.index
  }
  const at = definition === -1 ? lines.findIndex((line) => line.includes(anchor)) : definition
  if (at === -1) {
    return (
      `[fragment anchor '${anchor}' not found in the file; showing the head instead]\n` +
      fencedExcerpt(repositoryRoot, relative, excerptChars)
    )
  }

  const body = lines.slice(at).join('\n')
  const text = body.length <= excerptChars ? body : body.slice(0, excerptChars)
  const dropped = body.length - text.length
  const notes = [`[anchored at '${anchor}', line ${at + 1}; ${at} earlier lines not shown]`]
  const tail = dropped > 0 ? `\n… ${dropped} more characters not shown` : ''
  return `${notes.join('\n')}\n\`\`\`\n${text}${tail}\n\`\`\``
}
