/**
 * The `likec4-model` provider: native LikeC4 validation and model access.
 *
 * LikeC4 remains the only architecture-model representation. The helpers here
 * query the live model and are recomputed on every call; nothing is cached,
 * persisted, or passed through a phase contract, so no snapshot can drift from
 * `model.c4`.
 */

import { LikeC4 } from 'likec4'
import { relationshipId } from './ids.ts'

/** The native model type, inferred from the installed LikeC4 API. */
export type LikeC4Model = Awaited<ReturnType<LikeC4['computedModel']>>

/**
 * The metadata key carrying ownership prefixes.
 *
 * Plain LikeC4 metadata rather than a custom DSL extension: the model stays
 * valid for every other LikeC4 tool, and ownership lives beside the element
 * it describes.
 */
export const SOURCES_KEY = 'sources'

export interface LoadedModel {
  model: LikeC4Model
  errors: string[]
}

/**
 * Load and validate the LikeC4 workspace.
 *
 * Native LikeC4 validation gates the pipeline: if the model itself is invalid,
 * nothing downstream is trustworthy.
 */
export async function loadModel(workspaceDir: string): Promise<LoadedModel> {
  const likec4 = await LikeC4.fromWorkspace(workspaceDir, {
    printErrors: false,
    logger: false,
  })
  const errors = likec4
    .getErrors()
    .map((error) => `${error.sourceFsPath}:${error.line}: ${error.message}`)

  const model = await likec4.computedModel()

  // An empty model is not a passing model. A deleted `model.c4`, a wrong path,
  // or an over-broad `exclude` would otherwise yield zero ownership prefixes,
  // no errors, and a green build — the pipeline would gate on nothing.
  if (errors.length === 0 && [...model.elements()].length === 0) {
    errors.push(`${workspaceDir}: no LikeC4 elements found; is there a model in this workspace?`)
  }

  return { model, errors }
}

/**
 * Normalize a `sources` metadata value.
 *
 * LikeC4 stores metadata as `string | NonEmptyArray<string>` and collapses a
 * single-element list back to a bare string, so this cannot be avoided by an
 * authoring convention.
 */
export function normalizeSources(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw]
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string')
  return []
}

export interface OwnershipPrefix {
  elementId: string
  /** Repository-relative directory prefix, always ending in `/`. */
  prefix: string
  declared: string
}

export interface RejectedSource {
  elementId: string
  declared: string
  reason: string
}

export interface Ownership {
  prefixes: OwnershipPrefix[]
  rejected: RejectedSource[]
}

/**
 * Convert `sources` metadata into match prefixes.
 *
 * A source is a repository-relative directory prefix optionally ending in
 * `/**`. General glob semantics are deliberately not implemented yet, so
 * anything the prefix matcher cannot honour is rejected loudly rather than
 * silently producing a prefix that matches nothing — a silent miss makes the
 * gate fail open.
 */
export function ownershipPrefixes(model: LikeC4Model): Ownership {
  const prefixes: OwnershipPrefix[] = []
  const rejected: RejectedSource[] = []

  for (const element of model.elements()) {
    for (const declared of normalizeSources(element.metadata[SOURCES_KEY])) {
      const result = toPrefix(declared)
      if ('reason' in result) {
        rejected.push({ elementId: element.id, declared, reason: result.reason })
      } else {
        prefixes.push({ elementId: element.id, prefix: result.prefix, declared })
      }
    }
  }

  return { prefixes, rejected }
}

/**
 * Normalize one declared source into a directory prefix.
 *
 * Accepts `src/core`, `src/core/`, and `src/core/**`, tolerates a `./` or `/`
 * lead and Windows separators, and rejects any surviving wildcard. The trailing
 * slash is load-bearing: without it the prefix `src/` would also claim
 * `src-legacy/`.
 */
export function toPrefix(declared: string): { prefix: string } | { reason: string } {
  const trimmed = declared.trim()
  if (trimmed === '') return { reason: 'is empty' }

  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/?\*\*$/, '')
    .replace(/\/+$/, '')

  if (normalized === '') {
    return { reason: 'matches the whole repository; scope it to a directory' }
  }
  if (normalized.includes('*')) {
    return {
      reason: `contains an unsupported wildcard; use a directory prefix such as '${normalized.split('*')[0]?.replace(/\/+$/, '')}/**'`,
    }
  }
  if (/\.[cm]?[jt]sx?$/.test(normalized)) {
    return { reason: 'names a file; sources must name a directory' }
  }

  return { prefix: `${normalized}/` }
}

export interface DeclaredRelationship {
  id: string
  sourceId: string
  targetId: string
  kind: string | null
}

export interface DeclaredRelationships {
  byId: Map<string, DeclaredRelationship>
  /** Stable ids that more than one LikeC4 relationship maps onto. */
  duplicates: Map<string, number>
}

/**
 * Index declared relationships by their stable id.
 *
 * LikeC4 permits several relationships with the same source, target, and
 * kind, which all collapse onto one stable id here. Rather than disambiguate
 * with an ordinal — which would churn ids on unrelated model edits — the
 * collisions are counted and reported instead of silently dropped.
 */
export function declaredRelationships(model: LikeC4Model): DeclaredRelationships {
  const byId = new Map<string, DeclaredRelationship>()
  const duplicates = new Map<string, number>()

  for (const relationship of model.relationships()) {
    const kind = relationship.kind ?? null
    const id = relationshipId(relationship.source.id, relationship.target.id, kind)

    if (byId.has(id)) {
      duplicates.set(id, (duplicates.get(id) ?? 1) + 1)
      continue
    }
    byId.set(id, { id, sourceId: relationship.source.id, targetId: relationship.target.id, kind })
  }

  return { byId, duplicates }
}

/** True when `ancestor` contains `descendant` in the LikeC4 hierarchy. */
export function isAncestorOf(ancestor: string, descendant: string): boolean {
  return descendant.startsWith(`${ancestor}.`)
}

/** True when the two elements are the same element or nested one inside the other. */
export function isSameOrNested(a: string, b: string): boolean {
  return a === b || isAncestorOf(a, b) || isAncestorOf(b, a)
}

/**
 * Find a declared relationship that covers a dependency from source to target.
 *
 * A relationship declared between two parents covers traffic between their
 * descendants, matching LikeC4's own containment semantics. Without this, a
 * model with more than one level of nesting reports false violations that the
 * author cannot fix: LikeC4 itself rejects a relationship between a parent and
 * its own child.
 *
 * Kind is ignored: an observed TypeScript import carries no LikeC4 relationship
 * kind, so any declared relationship between the two elements counts.
 */
export function hasRelationship(
  declared: DeclaredRelationships,
  sourceId: string,
  targetId: string,
): DeclaredRelationship | undefined {
  for (const relationship of declared.byId.values()) {
    const coversSource =
      relationship.sourceId === sourceId || isAncestorOf(relationship.sourceId, sourceId)
    const coversTarget =
      relationship.targetId === targetId || isAncestorOf(relationship.targetId, targetId)
    if (coversSource && coversTarget) return relationship
  }
  return undefined
}
