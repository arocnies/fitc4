/**
 * The `agent-resolve` resolve provider.
 *
 * Maps observations the deterministic resolvers cannot map onto model
 * elements: dependencies on external packages, unresolvable specifiers,
 * implied links — anything whose target is not a file under a `sources`
 * prefix. This is what makes description-only "pure thought" elements — an
 * external system, a managed queue — reachable by the gate: the agent reads the
 * element catalog (title, description, ownership) and the leftover
 * observations, and proposes `resolved` associations that the standard
 * relationship rules then judge like any other edge.
 *
 * Composition: used ALONGSIDE the default resolver, never instead of it —
 * `resolve: [...defaultResolve, agentResolve({ exec })]`. Only observations
 * `source-root` cannot map are sent: `unresolved-dependency` observations and
 * `dependency` observations with a module/external target whose package no
 * element claims via `packages` metadata (a claimed package is deterministically
 * mapped by `source-root`, so offering it here would be redundant), and only
 * where the subject file has an unambiguous owning element (without one there
 * is no source end to hang a judgeable association on).
 *
 * **Fail-closed, deliberately unlike the advisory validate providers.** A
 * resolver that silently fails produces fewer associations, which means fewer
 * checks, which looks like a clean run — the exact fail-open this project
 * exists to prevent. Any exec failure, off-schema reply, hallucinated
 * `observationId`, or unknown `elementId` therefore THROWS, which the
 * pipeline reports as one `provider-failure` error finding attributed to this
 * provider. The core would catch a hallucinated observation id anyway
 * (`orphaned-association`), but this provider does not rely on that: a reply
 * that names ids it was never given is untrustworthy in full, not per entry.
 *
 * An *unanswered* candidate is different: mapping zero, some, or all
 * candidates is a legitimate "I don't know", and an unmapped candidate simply
 * keeps its deterministic `unresolved` association — still visible through
 * the existing rules. Candidates beyond `maxObservations` are treated the
 * same way: truncation is announced in the context (so the model knows its
 * list is partial) and the rest stay unmapped, not failed.
 *
 * The prefilled context is deterministic — element catalog plus candidate
 * listing — so the provider composes with `cached()` unchanged.
 */

import {
  declaredRelationships,
  hasRelationship,
  ownershipPrefixes,
  packageClaims,
  packageNameOf,
} from '../model.ts'
import type { OwnershipPrefix } from '../model.ts'
import type {
  Association,
  JsonObject,
  NamedProvider,
  Observation,
  ResolveContext,
  ResolveProvider,
} from '../types.ts'
import type { AgentExec } from './exec.ts'
import { schemaMismatch, truncate } from './exec.ts'
import { elementCatalog } from './findings.ts'

export const PROVIDER_ID = 'agent-resolve'

export interface AgentResolveOptions {
  exec: AgentExec
  /**
   * Optional mapping guidance in prose — e.g. "requests to payments.internal
   * belong to the payments-gateway element".
   */
  instructions?: string
  /** Suffix for the provider id: `agent-resolve:<id>` instead of `agent-resolve`. */
  id?: string
  /**
   * Candidates sent per run. The rest are announced as truncated in the
   * context and stay unmapped — visible through the existing rules, not a
   * failure.
   */
  maxObservations?: number
}

const DEFAULT_MAX_OBSERVATIONS = 100

const REPLY_SCHEMA: JsonObject = {
  type: 'array',
  items: {
    type: 'object',
    required: ['observationId', 'elementId'],
    properties: {
      observationId: { type: 'string' },
      elementId: { type: 'string' },
      reason: { type: 'string' },
    },
  },
}

const PROMPT =
  'Map each candidate observation in the context onto the id of the existing model element its ' +
  'target belongs to. Reply with a JSON array of mappings. Use only observationIds listed in the ' +
  'context, each at most once, and only element ids from the element catalog. Map a candidate ' +
  'only when the catalog clearly contains the thing the dependency points at; omit any candidate ' +
  'you are not confident about — an omitted candidate simply stays unmapped. ' +
  'Keep each reason to one sentence.'

export function agentResolve(options: AgentResolveOptions): NamedProvider<ResolveProvider> {
  const providerId = options.id === undefined ? PROVIDER_ID : `${PROVIDER_ID}:${options.id}`
  const maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS

  const run: ResolveProvider = async (context: ResolveContext): Promise<Association[]> => {
    const candidates = leftoverCandidates(context)
    if (candidates.length === 0) return []

    const sent = candidates.slice(0, maxObservations)
    const dropped = candidates.length - sent.length

    const reply = await options.exec.run({
      prompt: PROMPT,
      context: composeContext(context, options.instructions, sent, dropped),
      schema: REPLY_SCHEMA,
      cwd: context.repositoryRoot,
    })

    if (!reply.ok) {
      throw new Error(`Agent resolve was unavailable (${options.exec.id}): ${reply.error}`)
    }

    // The exec layer enforced the schema on a live reply, but a custom adapter
    // or a cache entry recorded against an older schema must not flow
    // malformed mappings into the pipeline as associations.
    const mismatch = schemaMismatch(reply.value, REPLY_SCHEMA)
    if (mismatch !== undefined) {
      throw new Error(`Agent resolve reply did not match the requested schema: ${mismatch}`)
    }

    const mappings = reply.value as unknown as {
      observationId: string
      elementId: string
      reason?: string
    }[]

    const byObservationId = new Map(sent.map((candidate) => [candidate.observation.id, candidate]))
    const knownElements = new Set<string>([...context.model.elements()].map((element) => element.id))
    const declared = declaredRelationships(context.model)

    const associations: Association[] = []
    const mapped = new Set<string>()

    for (const mapping of mappings) {
      // Hard hallucination guards. Ids the reply was never given, and elements
      // the model does not contain, fail the provider visibly — dropping the
      // entry would let the rest of an untrustworthy reply pass as clean.
      const candidate = byObservationId.get(mapping.observationId)
      if (candidate === undefined) {
        throw new Error(
          `Agent resolve reply named an observationId it was not given: '${truncate(mapping.observationId, 160)}'`,
        )
      }
      if (mapped.has(mapping.observationId)) {
        throw new Error(
          `Agent resolve reply mapped '${truncate(mapping.observationId, 160)}' more than once`,
        )
      }
      mapped.add(mapping.observationId)

      if (!knownElements.has(mapping.elementId)) {
        throw new Error(
          `Agent resolve reply named an element that is not in the model: '${truncate(mapping.elementId, 160)}'`,
        )
      }

      const match = hasRelationship(declared, candidate.sourceElementId, mapping.elementId)
      const targetName = candidate.observation.target?.id ?? candidate.observation.id

      associations.push({
        id: `mapped:${candidate.observation.id}`,
        observationId: candidate.observation.id,
        status: 'resolved',
        source: { kind: 'element', id: candidate.sourceElementId },
        target: { kind: 'element', id: mapping.elementId },
        ...(match === undefined ? {} : { relationship: { kind: 'relationship', id: match.id } }),
        description: `${candidate.sourceElementId} → ${mapping.elementId} (agent-mapped from ${targetName})`,
        data: {
          agent: options.exec.id,
          ...(mapping.reason === undefined ? {} : { reason: mapping.reason }),
        },
        provider: providerId,
      })
    }

    return associations
  }

  return { id: providerId, run }
}

interface Candidate {
  observation: Observation
  /** The unambiguous owner of the subject file — the association's source end. */
  sourceElementId: string
}

/**
 * The observations `source-root` cannot map, in stable id order.
 *
 * Recomputed per run from the same inputs `source-root` reads — providers
 * recompute rather than share state by design. A candidate is a dependency
 * whose target is not a repository file (external package, unresolvable
 * specifier), with a subject file owned by exactly one element: dependencies
 * with file targets are `source-root`'s job, and a subject without an
 * unambiguous owner has no source end for a resolved association.
 *
 * External dependencies whose package an element claims via `packages`
 * metadata are also excluded, mirroring `source-root`'s claim resolution:
 * `source-root` already maps them deterministically, so offering them to the
 * agent would be redundant.
 */
function leftoverCandidates(context: ResolveContext): Candidate[] {
  const { prefixes } = ownershipPrefixes(context.model)
  const claimed = new Set(packageClaims(context.model).claims.map((claim) => claim.name))
  const candidates: Candidate[] = []

  for (const observation of context.observations) {
    if (observation.kind !== 'dependency' && observation.kind !== 'unresolved-dependency') continue
    if (observation.target === undefined || observation.target.kind === 'file') continue
    if (observation.subject?.kind !== 'file') continue
    if (
      observation.kind === 'dependency' &&
      observation.target.kind === 'module' &&
      claimed.has(packageNameOf(observation.target.id))
    ) {
      continue
    }

    const owner = unambiguousOwner(observation.subject.id, prefixes)
    if (owner === undefined) continue

    candidates.push({ observation, sourceElementId: owner })
  }

  return candidates.sort((a, b) => a.observation.id.localeCompare(b.observation.id))
}

/**
 * The single owning element of a path — longest `sources` prefix wins,
 * mirroring `source-root`. Unowned and ambiguous paths return undefined.
 */
function unambiguousOwner(filePath: string, prefixes: OwnershipPrefix[]): string | undefined {
  const matches = prefixes.filter((candidate) => filePath.startsWith(candidate.prefix))
  if (matches.length === 0) return undefined

  const longest = Math.max(...matches.map((match) => match.prefix.length))
  const elementIds = [
    ...new Set(
      matches.filter((match) => match.prefix.length === longest).map((match) => match.elementId),
    ),
  ]
  return elementIds.length === 1 ? elementIds[0] : undefined
}

function composeContext(
  context: ResolveContext,
  instructions: string | undefined,
  sent: Candidate[],
  dropped: number,
): string {
  const parts = [elementCatalog(context.model)]

  if (instructions !== undefined && instructions !== '') {
    parts.push(`### Mapping instructions\n\n${instructions}`)
  }

  const lines = sent.map((candidate) => {
    const { observation, sourceElementId } = candidate
    const target = observation.target
    const what =
      observation.description ??
      `${observation.subject?.id} depends on ${target?.kind} ${target?.id}`
    return `- observationId: ${observation.id}\n  ${what} (subject owned by ${sourceElementId})`
  })
  parts.push(
    '### Candidate observations\n\n' +
      lines.join('\n') +
      (dropped > 0
        ? `\n\nNOTE: this listing is truncated — ${dropped} more candidates exist beyond the configured limit and will simply stay unmapped this run.`
        : ''),
  )

  return parts.join('\n\n')
}
