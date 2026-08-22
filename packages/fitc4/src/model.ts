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

/**
 * The metadata key claiming external npm packages.
 *
 * The same shape as `sources`: plain LikeC4 metadata, normalized the same way.
 * A value is an exact package name (`pg`, `@aws-sdk/client-s3`), never a
 * subpath — imports of any subpath map onto the claim via `packageNameOf`.
 */
export const PACKAGES_KEY = 'packages'

/**
 * The prefix marking a description as a scaffolded placeholder.
 *
 * `init` and `draft` both write `TODO: ...` descriptions, and three tiers need
 * to agree on what that means, so the test lives here in the shared model
 * vocabulary rather than in whichever of them tested for it first.
 */
const PLACEHOLDER_PREFIX = 'TODO'

/**
 * Whether a description says nothing: absent, blank, or still a placeholder.
 *
 * One definition, deliberately. `missing-descriptions` counts these
 * deterministically, and `agentSemanticReview` must skip exactly the same set,
 * because paying a model to report that the tool's own `TODO` states no
 * responsibility is waste (and on a freshly drafted repository it was waste
 * once per element). Two copies of this test would drift into a review that
 * bills for placeholders the rule already counted.
 */
export function isPlaceholderDescription(description: string | undefined): boolean {
  if (description === undefined) return true
  const trimmed = description.trim()
  return trimmed === '' || trimmed.startsWith(PLACEHOLDER_PREFIX)
}

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
  // no errors, and a green build. The pipeline would gate on nothing.
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
  /**
   * Repository-relative directory prefix ending in `/`, or a fragment claim
   * of the form `<file path>#<fragment>` (see `matchesClaim`).
   */
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
 *
 * A declared source containing `#` is a fragment claim instead: ownership of
 * a region inside one file, for domains where several elements live in a
 * single file (a compose file, a workflow definition). It normalizes to
 * `<file path>#<fragment>` with no trailing slash; matching semantics live in
 * `matchesClaim`.
 */
export function toPrefix(declared: string): { prefix: string } | { reason: string } {
  const trimmed = declared.trim()
  if (trimmed === '') return { reason: 'is empty' }
  if (trimmed.includes('#')) return toFragmentClaim(trimmed)

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

/**
 * Normalize one fragment claim, `<file path>#<fragment>`.
 *
 * The path part gets the same lead and separator tolerance as a directory
 * prefix; the fragment rides along as an opaque locator. Both halves must be
 * non-empty and wildcard-free, rejected loudly like any other claim the
 * matcher cannot honour.
 */
function toFragmentClaim(trimmed: string): { prefix: string } | { reason: string } {
  const hash = trimmed.indexOf('#')
  const fragment = trimmed.slice(hash + 1)
  const filePath = trimmed
    .slice(0, hash)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  if (filePath === '') return { reason: 'names a fragment without a file' }
  if (fragment === '') return { reason: 'names a file with an empty fragment' }
  if (filePath.includes('*') || fragment.includes('*')) {
    return { reason: 'contains an unsupported wildcard' }
  }

  return { prefix: `${filePath}#${fragment}` }
}

/** Whether a normalized ownership prefix is a fragment claim rather than a directory prefix. */
export function isFragmentClaim(prefix: string): boolean {
  return prefix.includes('#')
}

/**
 * Whether one normalized ownership claim covers a subject id.
 *
 * A directory prefix covers any path under it, its trailing slash guarding
 * the boundary. A fragment claim covers its exact locator and any locator
 * nested under it at a `.` boundary; the dot plays the trailing slash's role,
 * so `f#services.auth` never covers `f#services.auth2`. A fragment claim
 * never covers a plain path, while a directory prefix covers a fragment
 * subject through its file part, so an unclaimed fragment falls back to
 * whichever element owns the file.
 */
export function matchesClaim(prefix: string, subjectId: string): boolean {
  if (isFragmentClaim(prefix)) {
    return subjectId === prefix || subjectId.startsWith(`${prefix}.`)
  }
  return subjectId.startsWith(prefix)
}

/** The package a specifier names: `@scope/name/deep` → `@scope/name`, `name/deep` → `name`. */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  if (specifier.startsWith('@') && segments.length >= 2) return `${segments[0]}/${segments[1]}`
  return segments[0] ?? specifier
}

export interface PackageClaim {
  elementId: string
  /** The exact npm package name claimed. */
  name: string
  declared: string
}

export interface RejectedPackage {
  elementId: string
  declared: string
  reason: string
}

export interface PackageOwnership {
  claims: PackageClaim[]
  rejected: RejectedPackage[]
}

/**
 * Convert `packages` metadata into package claims.
 *
 * Mirrors `ownershipPrefixes`: anything that is not an exact npm package name
 * is rejected loudly rather than silently claiming nothing — a claim that
 * matches nothing makes the gate fail open.
 */
export function packageClaims(model: LikeC4Model): PackageOwnership {
  const claims: PackageClaim[] = []
  const rejected: RejectedPackage[] = []
  const seen = new Set<string>()

  for (const element of model.elements()) {
    for (const declared of normalizeSources(element.metadata[PACKAGES_KEY])) {
      const result = toPackageName(declared)
      if ('reason' in result) {
        rejected.push({ elementId: element.id, declared, reason: result.reason })
        continue
      }
      // The same element claiming the same package twice is one claim, not an
      // ambiguity; ambiguity is two *elements* claiming one package.
      const key = `${element.id}\u0000${result.name}`
      if (seen.has(key)) continue
      seen.add(key)
      claims.push({ elementId: element.id, name: result.name, declared })
    }
  }

  return { claims, rejected }
}

/**
 * Validate one declared package claim.
 *
 * Exact npm package names only. A subpath (`pg/promises`) is rejected rather
 * than truncated: silently claiming `pg` when the author wrote something
 * narrower would enforce more than they asked for.
 */
export function toPackageName(declared: string): { name: string } | { reason: string } {
  const trimmed = declared.trim()
  if (trimmed === '') return { reason: 'is empty' }
  if (/\s/.test(trimmed)) return { reason: 'contains whitespace' }
  if (trimmed.startsWith('.') || trimmed.startsWith('/')) {
    return { reason: 'is a path, not a package name' }
  }

  const segments = trimmed.split('/')
  const expected = trimmed.startsWith('@') ? 2 : 1
  if (trimmed.startsWith('@') && segments.length < 2) {
    return { reason: 'names a scope without a package' }
  }
  if (segments.length > expected || segments.some((segment) => segment === '')) {
    return {
      reason: `carries a subpath; claim the package '${packageNameOf(trimmed)}' instead`,
    }
  }

  return { name: trimmed }
}

export interface DeclaredRelationship {
  id: string
  sourceId: string
  targetId: string
  kind: string | null
  /** The relationship's declared tags, e.g. `['drift']`. */
  tags: readonly string[]
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
    byId.set(id, {
      id,
      sourceId: relationship.source.id,
      targetId: relationship.target.id,
      kind,
      tags: [...relationship.tags],
    })
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
