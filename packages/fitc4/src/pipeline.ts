/**
 * Pipeline orchestration.
 *
 *   native LikeC4 validation → scan → resolve → validate → report
 *
 * The core sequences the phases, namespaces provider output, and contains
 * provider failures. It never interprets a provider's `data` — it only checks
 * that the data could survive serialization.
 *
 * Every containment check here exists to stop the gate failing open. A
 * malformed provider result must become a visible error, never a quiet
 * omission that leaves the run green.
 */

import { findingId, namespaced } from './ids.ts'
import { loadModel, ownershipPrefixes, type LikeC4Model } from './model.ts'
import { isSeverity } from './types.ts'
import type {
  Association,
  Finding,
  JsonObject,
  NamedProvider,
  Observation,
  ResolveProvider,
  ScanProvider,
  ValidateProvider,
} from './types.ts'

export const CORE_PROVIDER_ID = 'arch'

export interface PipelineConfig {
  repositoryRoot: string
  /** Directory containing the LikeC4 workspace. */
  modelDir: string
  scan: NamedProvider<ScanProvider>[]
  resolve: NamedProvider<ResolveProvider>[]
  validate: NamedProvider<ValidateProvider>[]
}

/** The provider ids that composed each phase, in run order. */
export interface PhaseProviders {
  scan: string[]
  resolve: string[]
  validate: string[]
}

export interface PipelineResult {
  modelErrors: string[]
  /**
   * Always present, even when the model fails validation: what would have
   * judged the run is part of the result, so a replaced phase — deliberate or
   * accidental — is visible in every report rather than only in the config.
   */
  providers: PhaseProviders
  observations: Observation[]
  associations: Association[]
  findings: Finding[]
}

/**
 * Run the pipeline.
 *
 * Native LikeC4 validation gates everything: an invalid or empty model stops
 * the run before scanning, because nothing downstream would be trustworthy.
 */
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const providers: PhaseProviders = {
    scan: config.scan.map((provider) => provider.id),
    resolve: config.resolve.map((provider) => provider.id),
    validate: config.validate.map((provider) => provider.id),
  }

  const { model, errors } = await loadModel(config.modelDir)
  if (errors.length > 0) {
    return { modelErrors: errors, providers, observations: [], associations: [], findings: [] }
  }

  const sources = declaredSources(model)
  const findings: Finding[] = []

  const observations = await runPhase('scan', config.scan, findings, (provider) =>
    provider({ repositoryRoot: config.repositoryRoot, sources, changedPaths: [] }),
  )

  const associations = await runPhase('resolve', config.resolve, findings, (provider) =>
    provider({ model, observations, repositoryRoot: config.repositoryRoot, sources }),
  )
  findings.push(...orphanedAssociations(observations, associations))

  const produced = await runPhase('validate', config.validate, findings, (provider) =>
    provider({
      model,
      observations,
      associations,
      repositoryRoot: config.repositoryRoot,
      sources,
    }),
  )
  findings.push(...produced)

  return {
    modelErrors: [],
    providers,
    observations,
    associations,
    findings: findings.map(withKnownSeverity),
  }
}

/** Every `sources` prefix declared anywhere in the model. */
function declaredSources(model: LikeC4Model): string[] {
  const declared = ownershipPrefixes(model).prefixes.map((entry) => entry.declared)
  return [...new Set(declared)].sort()
}

/**
 * Run one phase's providers.
 *
 * A provider that throws becomes an `error` finding attributed to that provider
 * and the run continues. Aborting would hide every other provider's result, and
 * a failure reported through the normal finding path exercises the same
 * reporting and gating machinery as any other error.
 */
async function runPhase<TProvider, TItem extends { id: string; provider: string }>(
  phase: string,
  providers: NamedProvider<TProvider>[],
  findings: Finding[],
  invoke: (provider: TProvider) => Promise<TItem[]>,
): Promise<TItem[]> {
  const items: TItem[] = []
  const seen = new Map<string, string>()

  for (const provider of providers) {
    // Staged, then committed as a unit. A provider that fails partway
    // contributes nothing: half its output is not a result, it is a
    // misleading one.
    const staged: TItem[] = []
    const stagedIds = new Set<string>()

    try {
      for (const item of await invoke(provider.run)) {
        const ingested = ingest(provider.id, item)

        // Duplicate ids silently overwrite each other in every downstream
        // lookup, so a collision is reported rather than tolerated.
        if (stagedIds.has(ingested.id) || seen.has(ingested.id)) {
          throw new Error(`emitted a duplicate id in the ${phase} phase: ${ingested.id}`)
        }
        stagedIds.add(ingested.id)
        staged.push(ingested)
      }
    } catch (error) {
      findings.push(providerFailure(phase, provider.id, error))
      continue
    }

    for (const id of stagedIds) seen.set(id, provider.id)
    items.push(...staged)
  }

  return items
}

/**
 * Namespace an item and check it is JSON-safe.
 *
 * Namespacing prevents two providers colliding on a natural key such as
 * `file:src/index.ts`. `observationId` is deliberately left alone: a resolve
 * provider already received namespaced observations, so it references the
 * namespaced id — and `orphanedAssociations` reports it if that assumption
 * turns out to be wrong.
 */
function ingest<T extends { id: string; provider: string; data?: JsonObject }>(
  providerId: string,
  item: T,
): T {
  if (item.data !== undefined) assertJsonSafe(providerId, item.id, item.data)
  return { ...item, id: namespaced(providerId, item.id), provider: providerId }
}

/**
 * Reject anything that would not survive a JSON round trip.
 *
 * `JSON.stringify` alone only throws on cycles, BigInt, and throwing getters.
 * Values it silently discards — `undefined`, functions, symbols, Map, Set —
 * would vanish from `--json` output with no error, so the round trip is
 * compared rather than merely attempted.
 */
function assertJsonSafe(providerId: string, itemId: string, data: JsonObject): void {
  const reject = (reason: string): never => {
    throw new Error(`produced non-serializable data on ${itemId}: ${reason}`)
  }

  const open = new Set<unknown>()

  const walk = (value: unknown, path: string): void => {
    if (value === null) return
    if (typeof value === 'object' && open.has(value)) reject(`${path} is a cycle`)

    switch (typeof value) {
      case 'string':
      case 'boolean':
        return
      case 'number':
        if (!Number.isFinite(value)) reject(`${path} is ${String(value)}`)
        return
      case 'bigint':
      case 'function':
      case 'symbol':
      case 'undefined':
        return reject(`${path} is a ${typeof value}`)
    }

    open.add(value)

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      open.delete(value)
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return reject(`${path} is a ${(value as object).constructor?.name ?? 'non-plain object'}`)
    }
    if (Object.getOwnPropertySymbols(value as object).length > 0) {
      return reject(`${path} has symbol keys`)
    }
    for (const [key, entry] of Object.entries(value as object)) {
      walk(entry, `${path}.${key}`)
    }
    open.delete(value)
  }

  try {
    walk(data, 'data')
  } catch (error) {
    throw new Error(`${providerId} ${messageOf(error)}`)
  }

  try {
    JSON.stringify(data)
  } catch (error) {
    throw new Error(`${providerId} produced non-serializable data on ${itemId}: ${messageOf(error)}`)
  }
}

/**
 * Associations pointing at an observation that does not exist.
 *
 * Downstream rules skip these, so without a finding a resolve provider that
 * built `observationId` from a natural key instead of copying the namespaced id
 * would drop every association and exit 0.
 */
function orphanedAssociations(
  observations: Observation[],
  associations: Association[],
): Finding[] {
  const known = new Set(observations.map((observation) => observation.id))
  const orphaned = new Map<string, number>()

  for (const association of associations) {
    if (known.has(association.observationId)) continue
    orphaned.set(association.provider, (orphaned.get(association.provider) ?? 0) + 1)
  }

  return [...orphaned].map(([provider, count]) => ({
    id: findingId(CORE_PROVIDER_ID, 'orphaned-association', provider),
    ruleId: 'orphaned-association',
    severity: 'error' as const,
    description:
      `${provider} produced ${count} associations referencing unknown observations. ` +
      `observationId must be the namespaced observation id.`,
    subject: { kind: 'provider', id: provider },
    provider: CORE_PROVIDER_ID,
  }))
}

/**
 * Force an unrecognized severity to `error`.
 *
 * A finding whose severity is outside the union would otherwise be dropped by
 * the renderer and counted by nothing — invisible and ungated.
 */
function withKnownSeverity(finding: Finding): Finding {
  if (isSeverity(finding.severity)) return finding
  return {
    ...finding,
    severity: 'error',
    description: `${finding.description} (reported with unknown severity '${String(finding.severity)}')`,
  }
}

function providerFailure(phase: string, providerId: string, error: unknown): Finding {
  return {
    id: findingId(CORE_PROVIDER_ID, 'provider-failure', `${phase}/${providerId}`),
    ruleId: 'provider-failure',
    severity: 'error',
    description: `Provider ${providerId} failed during ${phase}: ${messageOf(error)}`,
    subject: { kind: 'provider', id: providerId },
    provider: CORE_PROVIDER_ID,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
