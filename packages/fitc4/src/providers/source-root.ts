/**
 * The `source-root` resolve provider.
 *
 * Associates observations with LikeC4 elements using `sources` metadata.
 * Longest matching prefix wins; a tie is genuine ambiguity in the model.
 *
 * Everything a validator needs is expressed through `Association`'s own
 * fields: `source`, `target`, `relationship`, `candidates`, `status`. Nothing
 * is passed through `data`, because a validator must work against the
 * `Association` contract rather than against this provider's private shape.
 */

import {
  declaredRelationships,
  elementsByName,
  hasRelationship,
  isSameOrNested,
  matchesClaim,
  normalizeElementName,
  ownershipPrefixes,
  packageClaims,
  packageNameOf,
  type DeclaredRelationships,
  type ElementNameIndex,
  type OwnershipPrefix,
} from '../model.ts'
import type {
  Association,
  NamedProvider,
  Observation,
  ResolveContext,
  ResolveProvider,
  Ref,
} from '../types.ts'

export const PROVIDER_ID = 'source-root'

/** Claiming element ids per package name, unique and sorted for determinism. */
type PackageClaimants = Map<string, string[]>

/** Returns a `NamedProvider`, ready to drop into a config's `resolve` array. */
export function sourceRoot(): NamedProvider<ResolveProvider> {
  const run: ResolveProvider = async (context: ResolveContext): Promise<Association[]> => {
    const { prefixes } = ownershipPrefixes(context.model)
    const declared = declaredRelationships(context.model)
    const claimants = claimantsByPackage(context)
    const names = elementsByName(context.model)
    const associations: Association[] = []

    for (const observation of context.observations) {
      if (observation.kind === 'file') {
        const association = fileAssociation(observation, prefixes)
        if (association !== undefined) associations.push(association)
        continue
      }
      // Both dependency kinds resolve the same way. An unresolvable target has
      // no owning element by construction, so it lands on the `unresolved`
      // branch below and the rules provider is the one that says anything
      // about it.
      if (observation.kind === 'dependency' || observation.kind === 'unresolved-dependency') {
        const association = dependencyAssociation(observation, prefixes, declared, claimants, names)
        if (association !== undefined) associations.push(association)
      }
    }

    return associations
  }

  return { id: PROVIDER_ID, run }
}

function claimantsByPackage(context: ResolveContext): PackageClaimants {
  const claimants: PackageClaimants = new Map()
  for (const claim of packageClaims(context.model).claims) {
    const existing = claimants.get(claim.name) ?? []
    if (!existing.includes(claim.elementId)) {
      claimants.set(claim.name, [...existing, claim.elementId].sort())
    }
  }
  return claimants
}

export type Ownership =
  | { status: 'resolved'; elementId: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' }

/**
 * Find the owning element of a repository-relative path, or of a fragment
 * subject (`<path>#<fragment>`) inside one.
 *
 * Longest claim wins, so a nested element takes precedence over its parent,
 * and a fragment claim beats a directory claim covering the same file. Two
 * equally long matches are ambiguous, and the model, not the file, is at
 * fault.
 */
export function ownerOf(filePath: string, prefixes: OwnershipPrefix[]): Ownership {
  const matches = prefixes.filter((candidate) => matchesClaim(candidate.prefix, filePath))
  if (matches.length === 0) return { status: 'unresolved' }

  const longest = Math.max(...matches.map((match) => match.prefix.length))
  const elementIds = [
    ...new Set(
      matches.filter((match) => match.prefix.length === longest).map((match) => match.elementId),
    ),
  ].sort()

  const [first, ...rest] = elementIds
  if (first === undefined) return { status: 'unresolved' }
  if (rest.length > 0) return { status: 'ambiguous', candidates: elementIds }
  return { status: 'resolved', elementId: first }
}

/**
 * Find the owning element of one dependency ref, whatever vocabulary the
 * scanner spoke.
 *
 * The ref's kind is descriptive, not structural: an agent describing a
 * compose service or a deployment writes `{ kind: 'service', id: ... }`
 * because that is what the thing is, and making ownership depend on it
 * saying 'file' instead would demand ref-kind discipline no instruction
 * should have to teach. So ownership goes by the id alone, in order of
 * evidence strength:
 *
 * 1. As a path or fragment claim — `ownerOf`, same as a plain file ref. A
 *    directory id gets a second try with a trailing slash, because claims
 *    are stored slash-terminated and `src/adservice` should land inside
 *    `src/adservice/**`.
 * 2. As an element name — the full LikeC4 id or its leaf, verbatim first and
 *    spelling-insensitively second, so `redis-cart` finds the `redis_cart`
 *    identifier LikeC4 forced. Only for refs that are not paths on their own
 *    evidence: `file` and `directory` refs went through the existence guard
 *    as paths, and `module` ids are package names where a name match would
 *    invent edges (a package named like an element is a coincidence, not an
 *    address).
 *
 * A name two elements share resolves as ambiguous, never as a guess.
 */
function refOwnership(
  ref: Ref,
  prefixes: OwnershipPrefix[],
  names: ElementNameIndex,
): Ownership {
  const byPath = ownerOf(ref.id, prefixes)
  if (byPath.status !== 'unresolved') return byPath

  if (!ref.id.includes('#') && !ref.id.endsWith('/')) {
    const asDirectory = ownerOf(`${ref.id}/`, prefixes)
    if (asDirectory.status !== 'unresolved') return asDirectory
  }

  if (ref.kind === 'file' || ref.kind === 'directory' || ref.kind === 'module') return byPath

  const elementIds =
    names.exact.get(ref.id) ?? names.normalized.get(normalizeElementName(ref.id))
  const [first, ...rest] = elementIds ?? []
  if (first === undefined) return { status: 'unresolved' }
  if (rest.length > 0) return { status: 'ambiguous', candidates: elementIds ?? [] }
  return { status: 'resolved', elementId: first }
}

/**
 * A reference to the owning model element.
 *
 * `element`, not `component`: an element carrying `sources` may be a container
 * just as easily, and the C4 kind belongs to the model rather than to a copy
 * of it made here.
 */
function element(id: string): Ref {
  return { kind: 'element', id }
}

function fileAssociation(
  observation: Observation,
  prefixes: OwnershipPrefix[],
): Association | undefined {
  const filePath = observation.subject?.id
  if (filePath === undefined) return undefined

  const ownership = ownerOf(filePath, prefixes)
  // Keyed on the observation, not the path: two scan providers can legitimately
  // observe the same file, and a path-derived id would collide between them.
  const base = {
    id: `file:${observation.id}`,
    observationId: observation.id,
    provider: PROVIDER_ID,
  }

  if (ownership.status === 'resolved') {
    return {
      ...base,
      status: 'resolved',
      source: element(ownership.elementId),
      description: `${filePath} is owned by ${ownership.elementId}`,
    }
  }
  if (ownership.status === 'ambiguous') {
    return {
      ...base,
      status: 'ambiguous',
      candidates: ownership.candidates.map(element),
      description: `${filePath} is claimed by ${ownership.candidates.join(' and ')}`,
    }
  }
  return { ...base, status: 'unresolved', description: `${filePath} is owned by no element` }
}

function dependencyAssociation(
  observation: Observation,
  prefixes: OwnershipPrefix[],
  declared: DeclaredRelationships,
  claimants: PackageClaimants,
  names: ElementNameIndex,
): Association | undefined {
  const subjectRef = observation.subject
  if (subjectRef === undefined) return undefined
  const fromPath = subjectRef.id

  const base = {
    id: `dependency:${observation.id}`,
    observationId: observation.id,
    provider: PROVIDER_ID,
  }

  // A module target may still map onto the model: an element can claim an
  // external package via `packages` metadata. Only demonstrably external
  // dependencies qualify. An unresolvable specifier already gets its own
  // `unresolved-import` finding, and resolving it here would silently bless a
  // broken import as a checked model edge.
  if (observation.kind === 'dependency' && observation.target?.kind === 'module') {
    const claimedBy = claimants.get(packageNameOf(observation.target.id))
    if (claimedBy !== undefined) {
      return packageAssociation(base, fromPath, observation.target.id, claimedBy, prefixes, declared)
    }
  }

  // An unclaimed package, a broken specifier, or a scanner's own abstention
  // (`unresolved-dependency`) has no owning element by construction, so there
  // is no model-level dependency for the contract to speak about. Every other
  // ref resolves below, whatever its kind: the kind is the model's choice of
  // words, and the id is what maps — as a path or fragment some element
  // claims, or as the name of an element itself.
  if (
    observation.kind !== 'dependency' ||
    observation.target === undefined ||
    observation.target.kind === 'module'
  ) {
    return {
      ...base,
      status: 'unresolved',
      description: `${fromPath} depends on something outside the model`,
    }
  }

  const toPath = observation.target.id
  const from = refOwnership(subjectRef, prefixes, names)
  const to = refOwnership(observation.target, prefixes, names)

  if (from.status !== 'resolved' || to.status !== 'resolved') {
    return {
      ...base,
      status: from.status === 'ambiguous' || to.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
      candidates: [
        ...(from.status === 'ambiguous' ? from.candidates : []),
        ...(to.status === 'ambiguous' ? to.candidates : []),
      ].map(element),
      description: `${fromPath} -> ${toPath} could not be mapped to two elements`,
    }
  }

  // A dependency between an element and itself, or between an element and one
  // of its own ancestors or descendants, stays inside one boundary. LikeC4
  // refuses to declare a parent-child relationship, so treating this as a
  // crossing would produce a violation the author cannot fix.
  if (isSameOrNested(from.elementId, to.elementId)) {
    return {
      ...base,
      status: 'resolved',
      source: element(from.elementId),
      target: element(to.elementId),
      description: `${from.elementId} depends within its own boundary`,
    }
  }

  const match = hasRelationship(declared, from.elementId, to.elementId)

  return {
    ...base,
    status: 'resolved',
    source: element(from.elementId),
    target: element(to.elementId),
    relationship: match === undefined ? undefined : { kind: 'relationship', id: match.id },
    description: `${from.elementId} -> ${to.elementId}`,
  }
}

/**
 * Map an external dependency onto the element claiming its package.
 *
 * From here on the association is indistinguishable from a file-to-file
 * crossing, with the same statuses and the same `relationship` lookup, so the
 * standard rules judge the edge with no package-specific rule code.
 */
function packageAssociation(
  base: { id: string; observationId: string; provider: string },
  fromPath: string,
  specifier: string,
  claimedBy: string[],
  prefixes: OwnershipPrefix[],
  declared: DeclaredRelationships,
): Association {
  const from = ownerOf(fromPath, prefixes)
  const [claimant, ...moreClaimants] = claimedBy

  if (from.status !== 'resolved' || claimant === undefined || moreClaimants.length > 0) {
    return {
      ...base,
      status:
        from.status === 'ambiguous' || moreClaimants.length > 0 ? 'ambiguous' : 'unresolved',
      candidates: [
        ...(from.status === 'ambiguous' ? from.candidates : []),
        ...(moreClaimants.length > 0 ? claimedBy : []),
      ].map(element),
      description: `${fromPath} -> ${specifier} could not be mapped to two elements`,
    }
  }

  // An element importing a package it claims itself stays inside one boundary,
  // exactly like a file-to-file dependency within one element.
  if (isSameOrNested(from.elementId, claimant)) {
    return {
      ...base,
      status: 'resolved',
      source: element(from.elementId),
      target: element(claimant),
      description: `${from.elementId} depends within its own boundary`,
    }
  }

  const match = hasRelationship(declared, from.elementId, claimant)

  return {
    ...base,
    status: 'resolved',
    source: element(from.elementId),
    target: element(claimant),
    relationship: match === undefined ? undefined : { kind: 'relationship', id: match.id },
    description: `${from.elementId} -> ${claimant} (package ${specifier})`,
  }
}
