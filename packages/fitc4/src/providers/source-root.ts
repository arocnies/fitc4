/**
 * The `source-root` resolve provider.
 *
 * Associates observations with LikeC4 elements using `sources` metadata.
 * Longest matching prefix wins; a tie is genuine ambiguity in the model.
 *
 * Everything a validator needs is expressed through `Association`'s own
 * fields — `source`, `target`, `relationship`, `candidates`, `status`. Nothing
 * is passed through `data`, because a validator must work against the
 * `Association` contract rather than against this provider's private shape.
 */

import {
  declaredRelationships,
  hasRelationship,
  isSameOrNested,
  ownershipPrefixes,
  type DeclaredRelationships,
  type OwnershipPrefix,
} from '../model.ts'
import type { Association, Observation, ResolveContext, Ref } from '../types.ts'

export const PROVIDER_ID = 'source-root'

export async function sourceRoot(context: ResolveContext): Promise<Association[]> {
  const { prefixes } = ownershipPrefixes(context.model)
  const declared = declaredRelationships(context.model)
  const associations: Association[] = []

  for (const observation of context.observations) {
    if (observation.kind === 'file') {
      const association = fileAssociation(observation, prefixes)
      if (association !== undefined) associations.push(association)
      continue
    }
    // Both dependency kinds resolve the same way. An unresolvable target has no
    // owning element by construction, so it lands on the `unresolved` branch
    // below and the rules provider is the one that says anything about it.
    if (observation.kind === 'dependency' || observation.kind === 'unresolved-dependency') {
      const association = dependencyAssociation(observation, prefixes, declared)
      if (association !== undefined) associations.push(association)
    }
  }

  return associations
}

export type Ownership =
  | { status: 'resolved'; elementId: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' }

/**
 * Find the owning element of a repository-relative path.
 *
 * Longest prefix wins, so a nested element takes precedence over its parent.
 * Two equally long matches are ambiguous — the model, not the file, is at
 * fault.
 */
export function ownerOf(filePath: string, prefixes: OwnershipPrefix[]): Ownership {
  const matches = prefixes.filter((candidate) => filePath.startsWith(candidate.prefix))
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
): Association | undefined {
  const fromPath = observation.subject?.id
  if (fromPath === undefined) return undefined

  const base = {
    id: `dependency:${observation.id}`,
    observationId: observation.id,
    provider: PROVIDER_ID,
  }

  // A package or a broken specifier has no owning element by construction, so
  // there is no model-level dependency for the contract to speak about.
  if (observation.target?.kind !== 'file') {
    return {
      ...base,
      status: 'unresolved',
      description: `${fromPath} depends on something outside the model`,
    }
  }

  const toPath = observation.target.id
  const from = ownerOf(fromPath, prefixes)
  const to = ownerOf(toPath, prefixes)

  if (from.status !== 'resolved' || to.status !== 'resolved') {
    return {
      ...base,
      status: from.status === 'ambiguous' || to.status === 'ambiguous' ? 'ambiguous' : 'unresolved',
      candidates: [
        ...(from.status === 'ambiguous' ? from.candidates : []),
        ...(to.status === 'ambiguous' ? to.candidates : []),
      ].map(element),
      description: `${fromPath} → ${toPath} could not be mapped to two elements`,
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
    description: `${from.elementId} → ${to.elementId}`,
  }
}
