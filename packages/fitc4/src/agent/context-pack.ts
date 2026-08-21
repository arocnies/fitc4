/**
 * Deterministic context packs for the agent providers.
 *
 * The pipeline already knows far more than the providers were sending: which
 * files import which, who owns each neighbor, what each element declares and
 * owns. This module turns that knowledge into prefilled context — pure
 * functions over what a provider already receives, no persistence, and no I/O
 * beyond bounded file reads for excerpts.
 *
 * Better prefill is the whole economy of the agent tier: a request that
 * carries the relevant facts needs no `agentic` exploration, which makes it
 * one-shot, cheaper, and honest under `cached()` — the content the model saw
 * is in the request, so it is in the cache key, and an edit invalidates the
 * recorded reply instead of replaying a stale one.
 *
 * Two attestation rules hold everywhere:
 *
 * - Every pack starts with a `context-pack v1` header line, so the format
 *   semantics are explicit in the cache key — a change to what a pack means
 *   bumps the version instead of colliding with replies recorded against the
 *   old shape.
 * - Truncation is always announced. Section builders report what they
 *   dropped, and the assembler writes an inline `NOTE: N <what> beyond budget
 *   not shown` so the model knows its view is partial. A silent cap would
 *   read as full coverage — the same fail-open the finding-level
 *   `agent-truncated` rule exists to prevent.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  declaredRelationships,
  matchesClaim,
  ownershipPrefixes,
  packageClaims,
  packageNameOf,
} from '../model.ts'
import type { OwnershipPrefix } from '../model.ts'
import type { Association, LikeC4Model, Observation } from '../types.ts'
import { elementText } from './findings.ts'

/**
 * The pack format version, and the first line of every assembled pack.
 *
 * In the request context — and therefore in the `cached()` key — on purpose:
 * a future change to what a pack means bumps this line rather than replaying
 * replies recorded against the old semantics.
 */
export const PACK_HEADER = 'context-pack v1'

/**
 * The default byte budget for one assembled pack.
 *
 * Roughly a dozen thousand tokens: generous enough that the default provider
 * limits fit, small enough that an unbounded repository cannot turn one
 * request into a novel. The assembler announces whatever it drops.
 */
export const DEFAULT_PACK_BUDGET_BYTES = 48_000

/** One outgoing dependency edge of a file, as observed. */
export interface NeighborEdge {
  /** Target ref id: a repository path, module specifier, or other ref id. */
  target: string
  /** Target ref kind: 'file', 'module', or a provider's own kind. */
  kind: string
}

/** Everything the graph knows about one model element. */
export interface ElementFacts {
  id: string
  title: string
  description: string | undefined
  /** Declared relationships this element participates in, either direction. */
  declared: { sourceId: string; targetId: string }[]
  /** Observed resolved element edges touching this element, with counts. */
  observed: { sourceId: string; targetId: string; count: number }[]
  /** The complete owned-file list, sorted. */
  ownedFiles: string[]
}

/**
 * The in-memory graph a provider run already implies.
 *
 * Built per run from the model and the observations (plus associations when
 * the phase has them) — providers recompute rather than share state by
 * design, so nothing here can drift from the run it describes.
 */
export interface ContextGraph {
  /** file → what it imports, deduplicated, sorted by target. */
  imports: Map<string, NeighborEdge[]>
  /** file → the files that import it, deduplicated and sorted. */
  importers: Map<string, string[]>
  /** package name → claiming element ids, sorted. */
  claimants: Map<string, string[]>
  /** element id → facts. Every element in the model has an entry. */
  elements: Map<string, ElementFacts>
  /** The unambiguous owning element of a path, or undefined. */
  ownerOf(filePath: string): string | undefined
}

/**
 * The single owning element of a path — longest `sources` prefix wins,
 * mirroring `source-root`'s resolution. Unowned and ambiguous paths return
 * undefined: neither has one element to speak for it.
 */
export function unambiguousOwner(
  filePath: string,
  prefixes: OwnershipPrefix[],
): string | undefined {
  const matches = prefixes.filter((candidate) => matchesClaim(candidate.prefix, filePath))
  if (matches.length === 0) return undefined

  const longest = Math.max(...matches.map((match) => match.prefix.length))
  const elementIds = [
    ...new Set(
      matches.filter((match) => match.prefix.length === longest).map((match) => match.elementId),
    ),
  ]
  return elementIds.length === 1 ? elementIds[0] : undefined
}

/**
 * Build the graph from what the provider already receives.
 *
 * Adjacency comes from `dependency` / `unresolved-dependency` observations,
 * ownership from `sources` prefixes, package claims from `packages` metadata,
 * and — when the phase has associations — resolved file ownership and
 * element-to-element edges from those. No new I/O, no persistence.
 */
export function buildGraph(
  model: LikeC4Model,
  observations: Observation[],
  associations: Association[] = [],
): ContextGraph {
  const { prefixes } = ownershipPrefixes(model)
  const ownerCache = new Map<string, string | undefined>()
  const ownerOf = (filePath: string): string | undefined => {
    if (!ownerCache.has(filePath)) ownerCache.set(filePath, unambiguousOwner(filePath, prefixes))
    return ownerCache.get(filePath)
  }

  const imports = new Map<string, NeighborEdge[]>()
  const importers = new Map<string, Set<string>>()
  const ownedFiles = new Map<string, Set<string>>()

  for (const observation of observations) {
    if (observation.kind === 'file' && observation.subject?.kind === 'file') {
      const owner = ownerOf(observation.subject.id)
      if (owner !== undefined) {
        if (!ownedFiles.has(owner)) ownedFiles.set(owner, new Set())
        ownedFiles.get(owner)?.add(observation.subject.id)
      }
      continue
    }

    if (observation.kind !== 'dependency' && observation.kind !== 'unresolved-dependency') continue
    if (observation.subject?.kind !== 'file' || observation.target === undefined) continue

    const from = observation.subject.id
    const edge: NeighborEdge = { target: observation.target.id, kind: observation.target.kind }
    const existing = imports.get(from) ?? []
    if (!existing.some((entry) => entry.target === edge.target && entry.kind === edge.kind)) {
      imports.set(from, [...existing, edge])
    }
    if (observation.target.kind === 'file') {
      if (!importers.has(observation.target.id)) importers.set(observation.target.id, new Set())
      importers.get(observation.target.id)?.add(from)
    }
  }

  // Associations refine what prefixes alone can say: an agent resolver may
  // have mapped a file no prefix owns, and resolved dependency associations
  // are the observed element edges no adjacency walk can produce.
  const observationById = new Map(observations.map((entry) => [entry.id, entry]))
  const edgeCounts = new Map<string, number>()
  for (const association of associations) {
    if (association.status !== 'resolved') continue
    const observation = observationById.get(association.observationId)
    if (observation === undefined) continue

    if (
      observation.kind === 'file' &&
      observation.subject?.kind === 'file' &&
      association.source?.kind === 'element'
    ) {
      if (!ownedFiles.has(association.source.id)) ownedFiles.set(association.source.id, new Set())
      ownedFiles.get(association.source.id)?.add(observation.subject.id)
    }

    if (
      (observation.kind === 'dependency' || observation.kind === 'unresolved-dependency') &&
      association.source?.kind === 'element' &&
      association.target?.kind === 'element' &&
      association.source.id !== association.target.id
    ) {
      const key = `${association.source.id} ${association.target.id}`
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
    }
  }

  const observedEdges = [...edgeCounts]
    .map(([key, count]) => {
      const [sourceId = '', targetId = ''] = key.split(' ')
      return { sourceId, targetId, count }
    })
    .sort((a, b) => `${a.sourceId}→${a.targetId}`.localeCompare(`${b.sourceId}→${b.targetId}`))

  const declared = [...declaredRelationships(model).byId.values()]
  const elements = new Map<string, ElementFacts>()
  for (const element of model.elements()) {
    elements.set(element.id, {
      id: element.id,
      title: element.title,
      description: elementText(element.description),
      declared: declared
        .filter((entry) => entry.sourceId === element.id || entry.targetId === element.id)
        .map((entry) => ({ sourceId: entry.sourceId, targetId: entry.targetId })),
      observed: observedEdges.filter(
        (entry) => entry.sourceId === element.id || entry.targetId === element.id,
      ),
      ownedFiles: [...(ownedFiles.get(element.id) ?? [])].sort(),
    })
  }

  const claimants = new Map<string, string[]>()
  for (const claim of packageClaims(model).claims) {
    const existing = claimants.get(claim.name) ?? []
    if (!existing.includes(claim.elementId)) {
      claimants.set(claim.name, [...existing, claim.elementId].sort())
    }
  }

  return {
    imports: new Map(
      [...imports].map(([file, edges]) => [
        file,
        [...edges].sort((a, b) => a.target.localeCompare(b.target)),
      ]),
    ),
    importers: new Map([...importers].map(([file, from]) => [file, [...from].sort()])),
    claimants,
    elements,
    ownerOf,
  }
}

/**
 * Compact neighborhood lines for one file: what it imports and what imports
 * it, each neighbor annotated with its owning element (or 'unowned'). Module
 * targets are annotated with their claiming element instead — the model-level
 * fact an ownership judgment actually needs.
 */
export function fileNeighborhood(graph: ContextGraph, filePath: string): string {
  const annotate = (neighbor: string): string => {
    const owner = graph.ownerOf(neighbor)
    return owner === undefined ? 'unowned' : `owned by ${owner}`
  }

  const lines: string[] = []
  for (const edge of graph.imports.get(filePath) ?? []) {
    if (edge.kind === 'file') {
      lines.push(`- imports ${edge.target} (${annotate(edge.target)})`)
    } else if (edge.kind === 'module') {
      const claimedBy = graph.claimants.get(packageNameOf(edge.target))
      const note = claimedBy === undefined ? 'unclaimed' : `claimed by ${claimedBy.join(', ')}`
      lines.push(`- imports module ${edge.target} (${note})`)
    } else {
      lines.push(`- imports ${edge.kind} ${edge.target}`)
    }
  }
  for (const importer of graph.importers.get(filePath) ?? []) {
    lines.push(`- imported by ${importer} (${annotate(importer)})`)
  }

  return lines.length === 0 ? '- no observed imports or importers' : lines.join('\n')
}

/**
 * The element-level facts a semantic judgment needs: description, declared
 * relationships, observed resolved edges, and the complete owned-file list —
 * complete on purpose, so the model knows what exists even when a file is not
 * excerpted. Pass `excerpted` to mark which files the surrounding context
 * actually shows.
 */
export function elementPack(
  graph: ContextGraph,
  elementId: string,
  options: { excerpted?: readonly string[] } = {},
): string {
  const facts = graph.elements.get(elementId)
  if (facts === undefined) {
    throw new Error(`elementPack: '${elementId}' is not an element in the model`)
  }

  const lines: string[] = [`### Element facts: ${facts.id} ('${facts.title}')`]
  lines.push(`Description: ${facts.description ?? '(none)'}`)

  lines.push('Declared relationships:')
  if (facts.declared.length === 0) lines.push('- (none)')
  for (const entry of facts.declared) lines.push(`- ${entry.sourceId} -> ${entry.targetId}`)

  lines.push('Observed resolved element edges:')
  if (facts.observed.length === 0) lines.push('- (none)')
  for (const entry of facts.observed) {
    const noun = entry.count === 1 ? 'dependency' : 'dependencies'
    lines.push(`- ${entry.sourceId} -> ${entry.targetId} (${entry.count} ${noun})`)
  }

  const excerpted = options.excerpted === undefined ? undefined : new Set(options.excerpted)
  if (excerpted === undefined) {
    lines.push(`Owned files (${facts.ownedFiles.length}):`)
    for (const file of facts.ownedFiles) lines.push(`- ${file}`)
  } else {
    const shown = facts.ownedFiles.filter((file) => excerpted.has(file)).length
    lines.push(`Owned files (${facts.ownedFiles.length} total, ${shown} excerpted below):`)
    for (const file of facts.ownedFiles) {
      lines.push(`- ${file} ${excerpted.has(file) ? '(excerpted)' : '(not excerpted)'}`)
    }
  }
  if (facts.ownedFiles.length === 0) lines.push('- (none)')

  return lines.join('\n')
}

export interface CodeFirstExcerpt {
  /** The excerpt body, after the comment skip and the character cap. */
  text: string
  /** Leading comment/blank lines skipped; 0 when nothing was skipped. */
  skippedLines: number
  /** Characters beyond the cap that are not shown; 0 when nothing was cut. */
  droppedChars: number
}

/**
 * A "code-first" excerpt: deterministically skip the leading run of blank
 * lines, `//` line comments, and `/* … *​/` block comments before applying
 * the character cap, so a file whose head is a long doc comment still shows
 * code. Only C-family comments are skipped — `#` lines are left alone, so
 * markdown, YAML, and shell content is never gutted. A file that is nothing
 * but comments keeps its full head: skipping to nowhere announces nothing.
 */
export function codeFirstExcerpt(content: string, excerptChars: number): CodeFirstExcerpt {
  const lines = content.split('\n')
  let index = 0
  let inBlock = false

  while (index < lines.length) {
    const line = (lines[index] ?? '').trim()
    if (inBlock) {
      const close = line.indexOf('*/')
      if (close === -1) {
        index += 1
        continue
      }
      inBlock = false
      if (line.slice(close + 2).trim() !== '') break // code after the close stays
      index += 1
      continue
    }
    if (line === '' || line.startsWith('//')) {
      index += 1
      continue
    }
    if (line.startsWith('/*')) {
      const close = line.indexOf('*/', 2)
      if (close === -1) {
        inBlock = true
        index += 1
        continue
      }
      if (line.slice(close + 2).trim() !== '') break
      index += 1
      continue
    }
    break
  }

  const remainder = lines.slice(index).join('\n')
  const body = remainder.trim() === '' ? content : remainder
  const skippedLines = remainder.trim() === '' ? 0 : index

  const text = body.length <= excerptChars ? body : body.slice(0, excerptChars)
  return { text, skippedLines, droppedChars: body.length - text.length }
}

/**
 * A fenced code-first excerpt of one file, with the skip and any truncation
 * announced inline at the head of the block. No heading line — the caller
 * owns the `### path` header, so two providers can frame the same excerpt
 * differently without duplicating it.
 */
export function fencedExcerpt(
  repositoryRoot: string,
  relative: string,
  excerptChars: number,
): string {
  let content: string
  try {
    content = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8')
  } catch {
    return '```\n(unreadable)\n```'
  }

  const excerpt = codeFirstExcerpt(content, excerptChars)
  const notes: string[] = []
  if (excerpt.skippedLines > 0) {
    notes.push(`[code-first: skipped ${excerpt.skippedLines} leading comment lines]`)
  }
  const tail = excerpt.droppedChars > 0 ? `\n… ${excerpt.droppedChars} more characters not shown` : ''
  return `${notes.length > 0 ? `${notes.join('\n')}\n` : ''}\`\`\`\n${excerpt.text}${tail}\n\`\`\``
}

/**
 * One budgetable section of a pack.
 *
 * The header is always shown; the items are what the byte budget may drop,
 * from the tail. `alreadyDropped` folds a caller's count cap into the same
 * announcement, so one NOTE line carries the whole truth about what the model
 * is not seeing.
 */
export interface PackSection {
  /** Heading (and any unbudgeted body); always included. */
  header: string
  /** Independent entries the budget may drop from the tail. */
  items: string[]
  /** Noun phrase for the announcement, e.g. `owned files of demo.core`. */
  what: string
  /** Entries the caller already dropped before assembly (count caps). */
  alreadyDropped?: number
}

export interface AssembledPack {
  text: string
  /** What was not shown, per section — for callers that attest via findings. */
  dropped: { what: string; count: number }[]
}

/**
 * Assemble sections into one pack under a byte budget.
 *
 * The `context-pack v1` header line comes first. Headers and NOTE lines are
 * exempt from the budget — the announcement of a partial view must never
 * itself be dropped for being over budget.
 */
export function assemblePack(sections: PackSection[], budgetBytes: number): AssembledPack {
  const parts: string[] = [PACK_HEADER]
  let used = Buffer.byteLength(PACK_HEADER, 'utf8')
  const dropped: { what: string; count: number }[] = []

  for (const section of sections) {
    const chunk: string[] = [section.header]
    used += Buffer.byteLength(`\n\n${section.header}`, 'utf8')

    let notShown = section.alreadyDropped ?? 0
    for (const [index, item] of section.items.entries()) {
      const cost = Buffer.byteLength(`\n${item}`, 'utf8')
      if (used + cost > budgetBytes) {
        notShown += section.items.length - index
        break
      }
      chunk.push(item)
      used += cost
    }

    if (notShown > 0) {
      chunk.push(`NOTE: ${notShown} ${section.what} beyond budget not shown`)
      dropped.push({ what: section.what, count: notShown })
    }
    parts.push(chunk.join('\n'))
  }

  return { text: parts.join('\n\n'), dropped }
}
