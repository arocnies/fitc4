/**
 * Scoring for the draft eval: compare one `DraftResult` against a reference
 * restatement of the fixture's known-good architecture.
 *
 * A draft fixture's `expectations.json` lists every element and relationship
 * of the reference model as plain data, in the reference's own names. Entries
 * marked `outsideScan: true` are the parts of that architecture the
 * configured scan cannot observe (a description-only element with no code, an
 * edge outside the scanned convention): the draft is not blamed for missing
 * them, they still count as hits if a run covers them anyway, and the fixture
 * README carries the coverage arithmetic they imply.
 *
 * Matching never uses the draft's raw identifiers, which it sanitizes,
 * keyword-mangles, and deduplicates. An element matches by the `sources`
 * prefix it claims, or by its title when the reference entry declares no
 * sources. Relationships match by (from, to) after mapping each drafted
 * endpoint to the reference element it matched; an edge with an unmapped
 * endpoint can only score as an extra.
 *
 * A fixture that opts into the describe pass may also give an element
 * `describeMust` / `describeMustNot` substrings, which turns
 * `draft-descriptions` from a presence check into one that can fail on
 * content: the description must name the real responsibility and must not
 * echo a misleading name. See `describeViolations`.
 *
 * The result is two scorecard rows in the harness's usual vocabulary:
 * `draft-elements` (which known elements the draft produced) and
 * `draft-edges` (which known relationships its edges covered). Extras are
 * drafted things the reference never declared, invented rather than observed.
 *
 * A fixture may additionally pin the gap between today's draft and the
 * reference, for architectures the draft's granularity is known not to reach.
 * A reference entry marked `expectedMiss: true` still counts in the misses
 * column when absent, so the column stays truthful, but a pinned miss does
 * not fail the row. `expectedExtras` names the coarse drafted output the
 * reference never declares, counted in the extras column the same way. Every
 * pin is checked in both directions: an expected miss that is covered and an
 * expected extra that never appears are stale pins, and a stale pin fails
 * stub mode so the fixture gets updated instead of rotting silently.
 */

import { architectureRules, runPipeline } from 'fitc4'
import type { DraftResult, ResolvedConfig } from 'fitc4'
import { agentSemanticReview, AGENT_SEMANTIC_REVIEW_PROVIDER_ID } from 'fitc4/agent'
import type { AgentExec } from 'fitc4/agent'

import type { FixtureScore, ProviderScore } from './score.ts'

export interface DraftExpectedElement {
  /** The reference model's name for this element. */
  name: string
  /** The `sources` prefix the reference element owns, when it owns one. */
  sources?: string
  /** True when the configured scan cannot observe this element. */
  outsideScan?: boolean
  /** True when today's draft is known to miss this entry (see the module doc). */
  expectedMiss?: boolean
  /**
   * Substrings this element's drafted description must contain,
   * case-insensitive. Every entry must appear, so the description has to name
   * the element's real responsibility rather than merely be non-empty. An
   * entry may offer alternatives as `a|b`, satisfied by any one of them, so a
   * rule tests the concept and not one spelling of it.
   */
  describeMust?: string[]
  /**
   * Substrings this element's drafted description must NOT contain,
   * case-insensitive. This is where a misleading directory name is caught: a
   * description assembled from the name says the forbidden word.
   */
  describeMustNot?: string[]
}

export interface DraftExpectedEdge {
  /** Reference element names, matched after mapping drafted endpoints. */
  from: string
  to: string
  /** True when the configured scan cannot observe this edge. */
  outsideScan?: boolean
  /** True when today's draft is known to miss this entry (see the module doc). */
  expectedMiss?: boolean
}

/** One drafted extra the fixture pins as today's known coarse output. */
export interface DraftPinnedExtraElement {
  /** The drafted element's title, exactly as the draft renders it. */
  title: string
  /** The drafted `sources` value, when the drafted element declares one. */
  sources?: string
}

export interface DraftPinnedExtraEdge {
  /**
   * Endpoints in reference names where the drafted endpoint matched a
   * reference element, drafted identifiers otherwise.
   */
  from: string
  to: string
}

export interface DraftExpectations {
  /** Every element of the reference model. */
  elements: DraftExpectedElement[]
  /** Every relationship of the reference model, as (from, to) pairs. */
  edges: DraftExpectedEdge[]
  /**
   * True when the fixture's spec opts into the describe pass. Adds a
   * `draft-descriptions` row: every matched claiming element must carry a
   * description that is not the TODO placeholder, since a described draft
   * with a leftover TODO means a describe call was dropped or refused.
   *
   * An element may additionally carry `describeMust` / `describeMustNot`,
   * which is what makes the row able to fail on quality rather than only on
   * absence. Elements without them keep the presence-only check, so a fixture
   * that declares no rules scores exactly as it did before.
   */
  describe?: boolean
  /**
   * Drafted output the reference never declares but today's draft is known
   * to emit: the artifacts of mirroring the observed dependency graph where
   * the reference chose a different granularity.
   * Counted in the extras column, does not fail the row, stale when absent.
   */
  expectedExtras?: {
    elements?: DraftPinnedExtraElement[]
    edges?: DraftPinnedExtraEdge[]
  }
}

/** One element as the draft rendered it, its id the full dotted path. */
interface DraftedElement {
  id: string
  title: string
  sources?: string
  description?: string
}

interface DraftedEdge {
  from: string
  to: string
}

/**
 * Parse the drafted model text back into elements and edges.
 *
 * This reads the exact line shapes `draft()`'s renderer emits (element
 * headers at their nesting indentation, their `sources` metadata, and the
 * relationship lines with their trailing dependency-count comments), so a
 * renderer change breaks the eval visibly instead of skewing the score.
 * Nesting is recovered from indentation: an element two spaces deeper than
 * the last one is its child, and ids are the dotted paths the edges use.
 */
function parseDraft(text: string): { elements: DraftedElement[]; edges: DraftedEdge[] } {
  const elements: DraftedElement[] = []
  const edges: DraftedEdge[] = []
  const stack: { indent: number; id: string }[] = []
  let current: DraftedElement | undefined

  for (const line of text.split('\n')) {
    const header = /^( +)([A-Za-z0-9_]+) = component (['"])(.*)\3 \{$/.exec(line)
    if (header !== null) {
      const indent = header[1]?.length ?? 0
      while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop()
      const id = [...stack.map((entry) => entry.id), header[2] ?? ''].join('.')
      stack.push({ indent, id: header[2] ?? '' })
      current = { id, title: header[4] ?? '' }
      elements.push(current)
      continue
    }
    const sources = /^ +sources (['"])(.*)\1$/.exec(line)
    if (sources !== null && current !== undefined) {
      current.sources = sources[2]
      continue
    }
    const description = /^ +description (['"])(.*)\1$/.exec(line)
    if (description !== null && current !== undefined) {
      current.description = description[2]
      continue
    }
    const edge = /^ {2}app\.([A-Za-z0-9_.]+) -> app\.([A-Za-z0-9_.]+)(?: \{ #[^}]+ \})? \/\//.exec(line)
    if (edge !== null) {
      edges.push({ from: edge[1] ?? '', to: edge[2] ?? '' })
    }
  }

  return { elements, edges }
}

/**
 * Close the describe-to-review loop: does the gate accept what draft wrote?
 *
 * The risk this measures is the two agent features feeding each other noise.
 * `draftDescriber` proposes a description, `agentSemanticReview` critiques
 * one, and nothing else in the suite runs them in that order. A describer
 * that writes configuration trivia ("listens on port 8000") produces a
 * `description-drift` finding the day the port moves, so a describe pass and
 * a reviewer that disagree by construction would ship as a permanent warning
 * on every freshly drafted repository.
 *
 * A draft fixture opts in with `export const review = true`. The drafted
 * model is already on disk in the fixture's temp model directory, so the loop
 * is one more pipeline run over the same project with the reviewer composed
 * in, and every review finding is an extra: a perfect run flags nothing about
 * descriptions written moments earlier from the same code.
 */
export async function scoreDescribeReview(
  config: ResolvedConfig,
  exec: AgentExec,
  drafted: DraftResult,
): Promise<ProviderScore> {
  const row: ProviderScore = { provider: 'draft-review', hits: 0, misses: 0, extras: 0, notes: [] }

  if (drafted.written === undefined) {
    row.misses += 1
    row.notes.push(`no model to review, the draft was not written: ${drafted.refusal ?? 'no reason given'}`)
    return row
  }

  const result = await runPipeline({
    ...config,
    validate: [architectureRules(), agentSemanticReview({ exec })],
  })
  if (result.modelErrors.length > 0) {
    row.misses += 1
    row.notes.push(`the drafted model did not load: ${result.modelErrors.join('; ')}`)
    return row
  }

  // Everything the reviewer says counts, not only drift: an `agent-unavailable`
  // or `agent-truncated` finding means the review did not actually happen, and
  // a review that never ran must not read as a clean one.
  const reviewFindings = result.findings.filter(
    (finding) => finding.provider === AGENT_SEMANTIC_REVIEW_PROVIDER_ID,
  )
  const flagged = new Set(
    reviewFindings
      .filter((finding) => finding.ruleId === 'description-drift')
      .map((finding) => finding.subject?.id),
  )
  for (const finding of reviewFindings) {
    row.extras += 1
    row.notes.push(`${finding.ruleId}: ${finding.description}`)
  }
  row.hits = Math.max(drafted.described - flagged.size, 0)
  return row
}

/**
 * How one drafted description breaks its element's rules, if it does.
 *
 * An element the fixture wrote no rules for gets no rules applied, and the
 * check stays what it always was: described at all. Where rules exist,
 * matching is case-insensitive substring containment, deliberately the
 * crudest oracle that can fail. The failure it exists to catch is coarse: a
 * description built from the element's name instead of its code names the
 * wrong responsibility outright, so it misses the required word and says the
 * forbidden one. Anything subtler than that is a live judgment call, and this
 * harness does not pretend to make judgment calls deterministically.
 */
function describeViolations(
  description: string,
  expected: DraftExpectedElement | undefined,
): string[] {
  const haystack = description.toLowerCase()
  const broken: string[] = []
  for (const required of expected?.describeMust ?? []) {
    // `a|b` accepts either wording, so a rule measures the concept rather
    // than one spelling of it: an element that is the process entry point is
    // described correctly whether the model writes "entry point" or
    // "entrypoint", and failing a right answer over a hyphen would make the
    // oracle a vocabulary test.
    const alternatives = required.split('|').map((option) => option.trim().toLowerCase())
    if (!alternatives.some((option) => option !== '' && haystack.includes(option))) {
      broken.push(`never says '${required}'`)
    }
  }
  for (const forbidden of expected?.describeMustNot ?? []) {
    if (haystack.includes(forbidden.toLowerCase())) broken.push(`says '${forbidden}'`)
  }
  return broken
}

export function scoreDraft(
  fixture: string,
  expectations: DraftExpectations,
  result: DraftResult,
): FixtureScore {
  const { elements, edges } = parseDraft(result.text)

  const elementRow: ProviderScore = { provider: 'draft-elements', hits: 0, misses: 0, extras: 0, notes: [] }
  const edgeRow: ProviderScore = { provider: 'draft-edges', hits: 0, misses: 0, extras: 0, notes: [] }

  // --- elements: match by sources prefix, or by title without one ---
  const referenceName = new Map<string, string>()
  const matchedElements = new Set<DraftedElement>()
  /** The reference entry each drafted element matched, for the description rules. */
  const matchedExpectation = new Map<DraftedElement, DraftExpectedElement>()
  for (const expected of expectations.elements) {
    const match = elements.find(
      (element) =>
        !matchedElements.has(element) &&
        (expected.sources !== undefined
          ? element.sources === expected.sources
          : element.title === expected.name),
    )
    const label = `${expected.name}${expected.sources === undefined ? '' : ` (${expected.sources})`}`
    if (match === undefined) {
      if (expected.outsideScan === true) continue
      elementRow.misses += 1
      if (expected.expectedMiss === true) {
        elementRow.pinned = (elementRow.pinned ?? 0) + 1
      } else {
        elementRow.notes.push(`missing element: ${label}`)
      }
      continue
    }
    matchedElements.add(match)
    matchedExpectation.set(match, expected)
    referenceName.set(match.id, expected.name)
    elementRow.hits += 1
    if (expected.expectedMiss === true) {
      elementRow.stale = (elementRow.stale ?? 0) + 1
      elementRow.notes.push(`stale pin, expected miss was covered: ${label}. Update expectations.json.`)
    }
  }
  const pinnedExtraElements = [...(expectations.expectedExtras?.elements ?? [])]
  for (const element of elements) {
    if (matchedElements.has(element)) continue
    elementRow.extras += 1
    const pinIndex = pinnedExtraElements.findIndex(
      (pin) => pin.title === element.title && pin.sources === element.sources,
    )
    if (pinIndex !== -1) {
      pinnedExtraElements.splice(pinIndex, 1)
      elementRow.pinned = (elementRow.pinned ?? 0) + 1
      continue
    }
    elementRow.notes.push(
      `invented element: ${element.title}${element.sources === undefined ? '' : ` (${element.sources})`}`,
    )
  }
  for (const pin of pinnedExtraElements) {
    elementRow.stale = (elementRow.stale ?? 0) + 1
    elementRow.notes.push(
      `stale pin, expected extra never appeared: ${pin.title}${pin.sources === undefined ? '' : ` (${pin.sources})`}. Update expectations.json.`,
    )
  }

  // --- edges: match by (from, to) in reference names ---
  const matchedEdges = new Set<DraftedEdge>()
  for (const expected of expectations.edges) {
    const match = edges.find(
      (edge) =>
        !matchedEdges.has(edge) &&
        referenceName.get(edge.from) === expected.from &&
        referenceName.get(edge.to) === expected.to,
    )
    if (match === undefined) {
      if (expected.outsideScan === true) continue
      edgeRow.misses += 1
      if (expected.expectedMiss === true) {
        edgeRow.pinned = (edgeRow.pinned ?? 0) + 1
      } else {
        edgeRow.notes.push(`missing relationship: ${expected.from} -> ${expected.to}`)
      }
      continue
    }
    matchedEdges.add(match)
    edgeRow.hits += 1
    if (expected.expectedMiss === true) {
      edgeRow.stale = (edgeRow.stale ?? 0) + 1
      edgeRow.notes.push(
        `stale pin, expected miss was covered: ${expected.from} -> ${expected.to}. Update expectations.json.`,
      )
    }
  }
  const pinnedExtraEdges = [...(expectations.expectedExtras?.edges ?? [])]
  for (const edge of edges) {
    if (matchedEdges.has(edge)) continue
    const from = referenceName.get(edge.from) ?? edge.from
    const to = referenceName.get(edge.to) ?? edge.to
    edgeRow.extras += 1
    const pinIndex = pinnedExtraEdges.findIndex((pin) => pin.from === from && pin.to === to)
    if (pinIndex !== -1) {
      pinnedExtraEdges.splice(pinIndex, 1)
      edgeRow.pinned = (edgeRow.pinned ?? 0) + 1
      continue
    }
    edgeRow.notes.push(`invented relationship: ${from} -> ${to}`)
  }
  for (const pin of pinnedExtraEdges) {
    edgeRow.stale = (edgeRow.stale ?? 0) + 1
    edgeRow.notes.push(
      `stale pin, expected extra never appeared: ${pin.from} -> ${pin.to}. Update expectations.json.`,
    )
  }

  // --- descriptions: described at all, and where the fixture says so, right ---
  const rows = [edgeRow, elementRow]
  if (expectations.describe === true) {
    const descriptionRow: ProviderScore = {
      provider: 'draft-descriptions',
      hits: 0,
      misses: 0,
      extras: 0,
      notes: [],
    }
    for (const element of matchedElements) {
      if (element.sources === undefined) continue
      const name = referenceName.get(element.id) ?? element.title
      const description = element.description
      if (description === undefined || description.startsWith('TODO')) {
        descriptionRow.misses += 1
        descriptionRow.notes.push(`undescribed element: ${name} kept the TODO`)
        continue
      }
      const broken = describeViolations(description, matchedExpectation.get(element))
      if (broken.length === 0) {
        descriptionRow.hits += 1
        continue
      }
      descriptionRow.misses += 1
      descriptionRow.notes.push(`wrong description: ${name} ${broken.join(', ')}`)
    }
    rows.push(descriptionRow)
  }

  // Pinned misses and extras stay out of the per-item notes (a deliberately
  // humbling fixture would drown the scorecard); one summary line per row
  // keeps them visible without the noise.
  for (const row of [elementRow, edgeRow]) {
    const pinned = row.pinned ?? 0
    if (pinned > 0) {
      row.notes.unshift(
        `${pinned} pinned ${pinned === 1 ? 'divergence' : 'divergences'}, expected of today's draft, see the fixture README`,
      )
    }
  }

  return { fixture, providers: rows.sort((a, b) => a.provider.localeCompare(b.provider)) }
}
