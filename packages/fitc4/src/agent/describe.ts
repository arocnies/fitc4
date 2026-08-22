/**
 * The draft describer (`fitc4/agent`).
 *
 * Builds the `describe` callback `draft()` accepts: per eligible element, one
 * one-shot exec call that proposes a one-or-two-sentence description from the
 * files the element owns. The draft stays a draft to rewrite. The describer
 * only ever proposes description text, at draft time, and the gate never
 * rewrites a description; `agentSemanticReview` only critiques one.
 *
 * Advisory by construction, matching `DraftOptions.describe`: any exec
 * failure, off-schema reply, or empty proposal returns `undefined`, which
 * keeps the element's TODO and never fails the draft. A placeholder is an
 * honest state; a draft aborted over a description would not be.
 *
 * Each request is a context pack over the element's owned files, so the same
 * attestation rules hold as everywhere else: truncation is announced inline,
 * and the deterministic context composes with `cached()` unchanged, making a
 * redrafted repository re-describe only the elements whose files changed.
 */

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
    const excerpted = element.ownedFiles.slice(0, maxFiles)
    const pack = assemblePack(
      [
        {
          header:
            `### Drafted element: ${element.name} (app.${element.path})\n` +
            `Declared sources claim: ${element.declared}\n` +
            `Owned files (${element.ownedFiles.length}):\n` +
            element.ownedFiles.map((file) => `- ${file}`).join('\n'),
          items: [],
          what: 'element facts',
        },
        {
          header: '### Owned-file excerpts (code-first)',
          items: excerpted.map(
            (file) => `### ${file}\n${fencedExcerpt(repositoryRoot, file, excerptChars)}`,
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
    const reply = await options.exec.run({
      prompt:
        `The context shows one element of a drafted architecture model: ` +
        `${element.name}, claiming '${element.declared}'. Write one or two plain sentences ` +
        'stating what this component is responsible for, based only on the files shown. ' +
        'Describe demonstrated responsibility, not implementation detail; do not speculate ' +
        'beyond what the files show.',
      context: pack.text,
      schema: REPLY_SCHEMA,
      cwd: repositoryRoot,
    })

    if (!reply.ok) return undefined

    const description = (reply.value as { description?: unknown }).description
    if (typeof description !== 'string') return undefined

    // LikeC4 descriptions here are single-line strings, so whitespace runs and
    // newlines collapse; an all-whitespace proposal is no proposal.
    const flattened = description.replace(/\s+/g, ' ').trim()
    return flattened === '' ? undefined : flattened
  }
}
