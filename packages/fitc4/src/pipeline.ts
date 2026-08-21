/**
 * Pipeline orchestration.
 *
 *   native LikeC4 validation → scan → resolve → validate → report
 *
 * The core sequences the phases, namespaces provider output, and contains
 * provider failures. It never interprets a provider's `data`. It only checks
 * that the data could survive serialization.
 *
 * Every containment check here exists to stop the gate failing open. A
 * malformed provider result must become a visible error, never a quiet
 * omission that leaves the run green.
 */

import { messageOf } from './errors.ts'
import { findingId, namespaced } from './ids.ts'
import { loadModel } from './model.ts'
import { count, elapsed } from './report.ts'
import { isSeverity } from './types.ts'
import { withViewerLinks } from './viewer.ts'
import type {
  Association,
  Finding,
  JsonObject,
  NamedProvider,
  Observation,
  Progress,
  ResolveProvider,
  ScanProvider,
  ValidateProvider,
} from './types.ts'

export const CORE_PROVIDER_ID = 'arch'

export interface PipelineConfig {
  repositoryRoot: string
  /** Directory containing the LikeC4 workspace. */
  modelDir: string
  /**
   * Base URL of a published LikeC4 viewer (`likec4 build`). When set, every
   * finding gets a `link` into the viewer and the report names the base URL.
   * Absent means no links; nothing else changes.
   */
  viewerBaseUrl?: string
  scan: NamedProvider<ScanProvider>[]
  resolve: NamedProvider<ResolveProvider>[]
  validate: NamedProvider<ValidateProvider>[]
  /**
   * Narration hook: one plain line per pipeline event (each phase start, each
   * provider start, each provider done with elapsed time and counts). The
   * library never touches a console; the CLI wires this to stderr. Absent
   * means silent, and the result is identical either way.
   */
  onProgress?: Progress
}

/** The provider ids that composed each phase, in run order. */
export interface PhaseProviders {
  scan: string[]
  resolve: string[]
  validate: string[]
}

export interface PipelineResult {
  modelErrors: string[]
  /** The configured viewer base URL, echoed so `--json` consumers and the report see it. */
  viewerBaseUrl?: string
  /**
   * Always present, even when the model fails validation: what would have
   * judged the run is part of the result, so a replaced phase is visible in
   * every report rather than only in the config, deliberate or accidental.
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

  const viewer = config.viewerBaseUrl === undefined ? {} : { viewerBaseUrl: config.viewerBaseUrl }
  const narrate = config.onProgress

  narrate?.(`model: loading ${config.modelDir}`)
  const { model, errors } = await loadModel(config.modelDir)
  if (errors.length > 0) {
    narrate?.(`model: invalid, ${count(errors.length, 'error')}, stopping`)
    return {
      modelErrors: errors,
      ...viewer,
      providers,
      observations: [],
      associations: [],
      findings: [],
    }
  }

  const findings: Finding[] = []

  const observations = await runPhase('scan', config.scan, findings, narrate, 'observation', (provider, progress) =>
    provider({ repositoryRoot: config.repositoryRoot, progress }),
  )

  const associations = await runPhase('resolve', config.resolve, findings, narrate, 'association', (provider, progress) =>
    provider({ model, observations, repositoryRoot: config.repositoryRoot, progress }),
  )
  findings.push(...orphanedAssociations(observations, associations))

  const produced = await runPhase('validate', config.validate, findings, narrate, 'finding', (provider, progress) =>
    provider({
      model,
      observations,
      associations,
      repositoryRoot: config.repositoryRoot,
      progress,
    }),
  )
  findings.push(...produced)

  const finalized = findings.map(withKnownSeverity)

  return {
    modelErrors: [],
    ...viewer,
    providers,
    observations,
    associations,
    findings:
      config.viewerBaseUrl === undefined
        ? finalized
        : withViewerLinks(finalized, model, config.viewerBaseUrl),
  }
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
  narrate: Progress | undefined,
  noun: string,
  invoke: (provider: TProvider, progress: Progress | undefined) => Promise<TItem[]>,
): Promise<TItem[]> {
  const items: TItem[] = []
  const seen = new Set<string>()

  narrate?.(`${phase}: ${count(providers.length, 'provider')}`)

  for (const provider of providers) {
    // Staged, then committed as a unit. A provider that fails partway
    // contributes nothing: half its output is not a result, it is a
    // misleading one.
    const staged: TItem[] = []
    const stagedIds = new Set<string>()

    narrate?.(`${phase}: ${provider.id}...`)
    const started = Date.now()
    // The provider-facing hook carries the provider's composed id, so provider
    // code narrates its work without knowing what it was composed as.
    const progress: Progress | undefined =
      narrate === undefined ? undefined : (message) => narrate(`${provider.id}: ${message}`)

    try {
      for (const item of await invoke(provider.run, progress)) {
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
      narrate?.(`${phase}: ${provider.id} failed, ${elapsed(started)}`)
      findings.push(providerFailure(phase, provider.id, error))
      continue
    }

    narrate?.(`${phase}: ${provider.id} done, ${count(staged.length, noun)}, ${elapsed(started)}`)
    for (const id of stagedIds) seen.add(id)
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
 * namespaced id, and `orphanedAssociations` reports it if that assumption
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
 * The values it silently discards, `undefined`, functions, symbols, Map, and
 * Set, would vanish from `--json` output with no error, so the walk below
 * rejects them explicitly; a final `stringify` attempt then catches whatever
 * throws (a hostile getter, say) rather than letting it break mid-report.
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
 * the renderer and counted by nothing, so invisible and ungated.
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
