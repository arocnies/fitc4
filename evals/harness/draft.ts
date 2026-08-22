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

import type { DraftResult } from 'fitc4'

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

  // --- descriptions: every matched claiming element must be described ---
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
      if (element.description !== undefined && !element.description.startsWith('TODO')) {
        descriptionRow.hits += 1
      } else {
        descriptionRow.misses += 1
        descriptionRow.notes.push(
          `undescribed element: ${referenceName.get(element.id) ?? element.title} kept the TODO`,
        )
      }
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
