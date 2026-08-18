/**
 * Core domain objects for the architecture control pipeline.
 *
 * There are exactly three pipeline result objects — observation, association,
 * finding — and the LikeC4 model is the only architecture-model
 * representation. Nothing here duplicates a LikeC4 element or relationship,
 * so no copy can drift from `model.c4`.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/**
 * A reference to something the pipeline can talk about.
 *
 * `kind` is typed as `string` rather than `RefKind` because the vocabulary is
 * open by design — a provider may name things the standard set does not cover.
 * The standard kinds, and what emitting them buys, are in `kinds.ts`.
 */
export interface Ref {
  kind: string
  id: string
}

export interface Evidence {
  path?: string
  line?: number
  detail?: string
}

/**
 * A compact implementation fact.
 *
 * `kind` decides which rules ever see this observation. See `kinds.ts` for the
 * standard set; a kind outside it is legal but unread by the standard rules,
 * which report it rather than pass silently.
 */
export interface Observation {
  id: string
  kind: string
  description?: string
  subject?: Ref
  target?: Ref
  evidence?: Evidence[]
  data?: JsonObject
  provider: string
}

/** A mapping from an observation to the native LikeC4 model. */
export interface Association {
  id: string
  observationId: string
  status: 'resolved' | 'unresolved' | 'ambiguous'
  source?: Ref
  target?: Ref
  relationship?: Ref
  /**
   * The competing owners when `status` is `ambiguous`.
   *
   * First-class rather than provider `data`, because a validator must be able
   * to read it without knowing which resolve provider ran.
   */
  candidates?: Ref[]
  description?: string
  data?: JsonObject
  provider: string
}

export type Severity = 'error' | 'warning' | 'info'

export const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info']

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
}

/** The common output of every validation provider. */
export interface Finding {
  id: string
  ruleId: string
  severity: Severity
  description: string
  subject?: Ref
  related?: Ref[]
  evidence?: Evidence[]
  data?: JsonObject
  provider: string
}

/**
 * The native LikeC4 model, as returned by the installed LikeC4 API.
 *
 * This is an alias, not a wrapper type. Providers use the LikeC4 Model API
 * directly rather than a snapshot that could drift from `model.c4`.
 */
export type { LikeC4Model } from './model.ts'

import type { LikeC4Model } from './model.ts'

export interface ScanContext {
  repositoryRoot: string
}

export interface ResolveContext {
  model: LikeC4Model
  observations: Observation[]
  repositoryRoot: string
}

export interface ValidateContext {
  model: LikeC4Model
  observations: Observation[]
  associations: Association[]
  repositoryRoot: string
}

export type ScanProvider = (context: ScanContext) => Promise<Observation[]>
export type ResolveProvider = (context: ResolveContext) => Promise<Association[]>
export type ValidateProvider = (context: ValidateContext) => Promise<Finding[]>

/**
 * A provider paired with the id the core uses to namespace its output and
 * attribute its failures.
 */
export interface NamedProvider<T> {
  id: string
  run: T
}
