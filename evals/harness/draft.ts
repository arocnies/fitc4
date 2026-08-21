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
}

export interface DraftExpectedEdge {
  /** Reference element names, matched after mapping drafted endpoints. */
  from: string
  to: string
  /** True when the configured scan cannot observe this edge. */
  outsideScan?: boolean
}

export interface DraftExpectations {
  /** Every element of the reference model. */
  elements: DraftExpectedElement[]
  /** Every relationship of the reference model, as (from, to) pairs. */
  edges: DraftExpectedEdge[]
}

/** One element as the draft rendered it. */
interface DraftedElement {
  id: string
  title: string
  sources?: string
}

interface DraftedEdge {
  from: string
  to: string
}

/**
 * Parse the drafted model text back into elements and edges.
 *
 * This reads the exact line shapes `draft()`'s renderer emits (element
 * headers, their `sources` metadata, and the relationship lines with their
 * trailing dependency-count comments), so a renderer change breaks the eval
 * visibly instead of skewing the score.
 */
function parseDraft(text: string): { elements: DraftedElement[]; edges: DraftedEdge[] } {
  const elements: DraftedElement[] = []
  const edges: DraftedEdge[] = []
  let current: DraftedElement | undefined

  for (const line of text.split('\n')) {
    const header = /^ {4}([A-Za-z0-9_]+) = component (['"])(.*)\2 \{$/.exec(line)
    if (header !== null) {
      current = { id: header[1] ?? '', title: header[3] ?? '' }
      elements.push(current)
      continue
    }
    const sources = /^ {8}sources (['"])(.*)\1$/.exec(line)
    if (sources !== null && current !== undefined) {
      current.sources = sources[2]
      continue
    }
    const edge = /^ {2}app\.([A-Za-z0-9_]+) -> app\.([A-Za-z0-9_]+)(?: \{ #[^}]+ \})? \/\//.exec(line)
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
    if (match === undefined) {
      if (expected.outsideScan === true) continue
      elementRow.misses += 1
      elementRow.notes.push(
        `missing element: ${expected.name}${expected.sources === undefined ? '' : ` (${expected.sources})`}`,
      )
      continue
    }
    matchedElements.add(match)
    referenceName.set(match.id, expected.name)
    elementRow.hits += 1
  }
  for (const element of elements) {
    if (matchedElements.has(element)) continue
    elementRow.extras += 1
    elementRow.notes.push(
      `invented element: ${element.title}${element.sources === undefined ? '' : ` (${element.sources})`}`,
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
      edgeRow.notes.push(`missing relationship: ${expected.from} -> ${expected.to}`)
      continue
    }
    matchedEdges.add(match)
    edgeRow.hits += 1
  }
  for (const edge of edges) {
    if (matchedEdges.has(edge)) continue
    const from = referenceName.get(edge.from) ?? edge.from
    const to = referenceName.get(edge.to) ?? edge.to
    edgeRow.extras += 1
    edgeRow.notes.push(`invented relationship: ${from} -> ${to}`)
  }

  return { fixture, providers: [edgeRow, elementRow].sort((a, b) => a.provider.localeCompare(b.provider)) }
}
