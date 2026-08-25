/**
 * The `agent-resolve` resolve provider.
 *
 * Maps observations the deterministic resolvers cannot map onto model
 * elements: dependencies on external packages, unresolvable specifiers,
 * implied links, anything whose target is not a file under a `sources`
 * prefix. This is what makes description-only "pure thought" elements
 * reachable by the gate, an external system or a managed queue: the agent reads
 * the element catalog (title, description, ownership) and the leftover
 * observations, and proposes `resolved` associations that the standard
 * relationship rules then judge like any other edge.
 *
 * Composition: used ALONGSIDE the default resolver, never instead of it, as in
 * `resolve: [sourceRoot(), agentResolve({ exec })]`. Only observations
 * `source-root` cannot map are sent: `unresolved-dependency` observations and
 * `dependency` observations with a module/external target whose package no
 * element claims via `packages` metadata (a claimed package is deterministically
 * mapped by `source-root`, so offering it here would be redundant), and only
 * where the subject file has an unambiguous owning element (without one there
 * is no source end to hang a judgeable association on).
 *
 * **Fail-closed, deliberately unlike the advisory validate providers.** A
 * resolver that silently fails produces fewer associations, which means fewer
 * checks, which looks like a clean run. That is the exact fail-open this
 * project exists to prevent. Any exec failure, off-schema reply, hallucinated
 * `observationId`, or unknown `elementId` therefore THROWS, which the
 * pipeline reports as one `provider-failure` error finding attributed to this
 * provider. The core would catch a hallucinated observation id anyway
 * (`orphaned-association`), but this provider does not rely on that: a reply
 * that names ids it was never given is untrustworthy in full, not per entry.
 *
 * An *unanswered* candidate is different: mapping zero, some, or all
 * candidates is a legitimate "I don't know", and an unmapped candidate simply
 * keeps its deterministic `unresolved` association, still visible through
 * the existing rules. Candidates beyond `maxObservations` are treated the
 * same way: truncation is announced in the context (so the model knows its
 * list is partial) and the rest stay unmapped, not failed.
 *
 * **Candidates are decisions, not import sites.** Twelve imports of `stripe`
 * from files owned by one element are one question, "which element does that
 * package belong to?", so leftover observations collapse to distinct
 * (owning-element, package-or-specifier) decisions, each with a stable
 * `candidateId` and a site count. The reply maps `candidateId → elementId`,
 * and an accepted mapping fans back out to one association per underlying
 * observation, so the standard rules still see every site. `maxObservations`
 * counts decisions.
 *
 * The prefilled context is the element catalog plus the decision listing, both
 * deterministic, so the provider composes with `cached()` unchanged.
 */

import {
  declaredRelationships,
  hasRelationship,
  ownershipPrefixes,
  packageClaims,
  packageNameOf,
} from '../model.ts'
import { count } from '../report.ts'
import type {
  Association,
  JsonObject,
  NamedProvider,
  Observation,
  ResolveContext,
  ResolveProvider,
} from '../types.ts'
import { unambiguousOwner } from './context-pack.ts'
import type { AgentExec } from './exec.ts'
import { schemaMismatch, truncate } from './exec.ts'
import { elementCatalog } from './findings.ts'

export const PROVIDER_ID = 'agent-resolve'

export interface AgentResolveOptions {
  exec: AgentExec
  /**
   * Optional mapping guidance in prose. For example: "requests to
   * payments.internal belong to the payments-gateway element".
   */
  instructions?: string
  /** Suffix for the provider id: `agent-resolve:<id>` instead of `agent-resolve`. */
  id?: string
  /**
   * Candidate *decisions* sent per run, meaning distinct (owning-element,
   * target) pairs, not import sites. The context announces the rest as
   * truncated and they stay unmapped, visible through the existing rules, not
   * a failure.
   */
  maxObservations?: number
}

const DEFAULT_MAX_OBSERVATIONS = 100

/** Import sites named per decision line before the count elides the rest. */
const SITES_SHOWN = 5

const REPLY_SCHEMA: JsonObject = {
  type: 'array',
  items: {
    type: 'object',
    required: ['candidateId', 'elementId'],
    properties: {
      candidateId: { type: 'string' },
      elementId: { type: 'string' },
      reason: { type: 'string' },
    },
  },
}

const PROMPT =
  'Map each candidate decision in the context onto the id of the existing model element its ' +
  'target belongs to. Reply with a JSON array of mappings. Use only candidateIds listed in the ' +
  'context, each at most once, and only element ids from the element catalog. Map a candidate ' +
  'only when the catalog clearly contains the thing the dependency points at; omit any candidate ' +
  'you are not confident about — an omitted candidate simply stays unmapped. ' +
  'A package that is a client, driver, SDK, or protocol library for an external system belongs to ' +
  'the element standing for that system, because importing the client is how this code talks to ' +
  'it; map it there rather than onto a general library or external-package bucket, which is only ' +
  'for packages no element in the catalog stands for. ' +
  'Keep each reason to one sentence.'

export function agentResolve(options: AgentResolveOptions): NamedProvider<ResolveProvider> {
  const providerId = options.id === undefined ? PROVIDER_ID : `${PROVIDER_ID}:${options.id}`
  const maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS

  const run: ResolveProvider = async (context: ResolveContext): Promise<Association[]> => {
    const decisions = leftoverDecisions(context)
    if (decisions.length === 0) return []

    const sent = decisions.slice(0, maxObservations)
    const dropped = decisions.length - sent.length

    // Announce before the call: it is the slow part, and the count says why.
    context.progress?.(`asking ${options.exec.id} to map ${count(sent.length, 'candidate')}`)

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
      candidateId: string
      elementId: string
      reason?: string
    }[]

    const byCandidateId = new Map(sent.map((decision) => [decision.candidateId, decision]))
    const knownElements = new Set<string>([...context.model.elements()].map((element) => element.id))
    const declared = declaredRelationships(context.model)

    const associations: Association[] = []
    const mapped = new Set<string>()

    for (const mapping of mappings) {
      // Hard hallucination guards. Ids the reply was never given, and elements
      // the model does not contain, fail the provider visibly. Dropping the
      // entry would let the rest of an untrustworthy reply pass as clean.
      const decision = byCandidateId.get(mapping.candidateId)
      if (decision === undefined) {
        throw new Error(
          `Agent resolve reply named a candidateId it was not given: '${truncate(mapping.candidateId, 160)}'`,
        )
      }
      if (mapped.has(mapping.candidateId)) {
        throw new Error(
          `Agent resolve reply mapped '${truncate(mapping.candidateId, 160)}' more than once`,
        )
      }
      mapped.add(mapping.candidateId)

      if (!knownElements.has(mapping.elementId)) {
        throw new Error(
          `Agent resolve reply named an element that is not in the model: '${truncate(mapping.elementId, 160)}'`,
        )
      }

      const match = hasRelationship(declared, decision.sourceElementId, mapping.elementId)

      // One accepted decision fans back out to one association per underlying
      // observation, so the standard rules still see every import site.
      for (const observation of decision.observations) {
        const targetName = observation.target?.id ?? observation.id
        associations.push({
          id: `mapped:${observation.id}`,
          observationId: observation.id,
          status: 'resolved',
          source: { kind: 'element', id: decision.sourceElementId },
          target: { kind: 'element', id: mapping.elementId },
          ...(match === undefined ? {} : { relationship: { kind: 'relationship', id: match.id } }),
          description: `${decision.sourceElementId} -> ${mapping.elementId} (agent-mapped from ${targetName})`,
          data: {
            agent: options.exec.id,
            candidateId: decision.candidateId,
            ...(mapping.reason === undefined ? {} : { reason: mapping.reason }),
          },
          provider: providerId,
        })
      }
    }

    return associations
  }

  return { id: providerId, run }
}

interface Decision {
  /** Stable id derived from the owner and the target key, never from sites. */
  candidateId: string
  /** The unambiguous owner of every subject file, the associations' source end. */
  sourceElementId: string
  /** The ref kind of the target ('module', or a provider's own kind). */
  targetKind: string
  /** Package name for module dependencies; the raw specifier otherwise. */
  targetKey: string
  /** True when the key is a package name covering possibly-deeper specifiers. */
  packaged: boolean
  /** Every underlying observation, the import sites this decision fans out to. */
  observations: Observation[]
}

/**
 * The observations `source-root` cannot map, collapsed into distinct
 * decisions and sorted by `candidateId`.
 *
 * Recomputed per run from the same inputs `source-root` reads. Providers
 * recompute rather than share state by design. A candidate observation is a
 * dependency whose target is not a repository file (external package,
 * unresolvable specifier), with a subject file owned by exactly one element:
 * dependencies with file targets are `source-root`'s job, and a subject
 * without an unambiguous owner has no source end for a resolved association.
 *
 * External dependencies whose package an element claims via `packages`
 * metadata are also excluded, mirroring `source-root`'s claim resolution:
 * `source-root` already maps them deterministically, so offering them to the
 * agent would be redundant.
 *
 * Candidate observations then collapse: every site whose subject is owned by
 * one element and whose target names one package (via `packageNameOf` for
 * resolvable module targets; the raw specifier otherwise) is the same
 * question, asked once.
 */
function leftoverDecisions(context: ResolveContext): Decision[] {
  const { prefixes } = ownershipPrefixes(context.model)
  const claimed = new Set(packageClaims(context.model).claims.map((claim) => claim.name))
  const decisions = new Map<string, Decision>()

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

    // A resolvable module target keys on its package: `stripe` and
    // `stripe/webhooks` are one decision. An unresolvable specifier keys on
    // itself, since `./missing.js` names no package.
    const packaged = observation.kind === 'dependency' && observation.target.kind === 'module'
    const targetKey = packaged ? packageNameOf(observation.target.id) : observation.target.id
    const candidateId = `${owner}=>${targetKey}`

    const existing = decisions.get(candidateId)
    if (existing === undefined) {
      decisions.set(candidateId, {
        candidateId,
        sourceElementId: owner,
        targetKind: observation.target.kind,
        targetKey,
        packaged,
        observations: [observation],
      })
    } else {
      existing.observations.push(observation)
    }
  }

  for (const decision of decisions.values()) {
    decision.observations.sort((a, b) => a.id.localeCompare(b.id))
  }
  return [...decisions.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId))
}

function composeContext(
  context: ResolveContext,
  instructions: string | undefined,
  sent: Decision[],
  dropped: number,
): string {
  const parts = [elementCatalog(context.model)]

  if (instructions !== undefined && instructions !== '') {
    parts.push(`### Mapping instructions\n\n${instructions}`)
  }

  const lines = sent.map((decision) => {
    const sites = decision.observations.map((observation) => {
      const line = observation.evidence?.[0]?.line
      return line === undefined ? `${observation.subject?.id}` : `${observation.subject?.id}:${line}`
    })
    const shown = sites.slice(0, SITES_SHOWN)
    const elided = sites.length - shown.length
    const siteList = shown.join(', ') + (elided > 0 ? ` and ${elided} more` : '')

    const unresolvable = decision.observations.every(
      (observation) => observation.kind === 'unresolved-dependency',
    )
    const verb = unresolvable ? 'references unresolvable' : 'depends on'
    const noun = decision.packaged ? 'package' : decision.targetKind
    const siteNoun = sites.length === 1 ? 'import site' : 'import sites'

    return (
      `- candidateId: ${decision.candidateId}\n` +
      `  ${decision.sourceElementId} ${verb} ${noun} ${decision.targetKey} ` +
      `at ${sites.length} ${siteNoun}: ${siteList}`
    )
  })
  parts.push(
    '### Candidate decisions\n\n' +
      lines.join('\n') +
      (dropped > 0
        ? `\n\nNOTE: this listing is truncated — ${dropped} more candidate decisions exist beyond the configured limit and will simply stay unmapped this run.`
        : ''),
  )

  return parts.join('\n\n')
}
