/**
 * The `soffit` library entry point.
 *
 * The CLI in `cli.ts` is one caller of this surface, not a layer above it —
 * anything it can do is reachable here, so a host project can run the pipeline
 * inside its own test suite instead of shelling out.
 *
 * Providers are exported individually rather than behind a registry. Composing
 * them is the caller's job (POC-DESIGN-v4 defers configurable providers), and a
 * caller that wants a different scanner supplies a function.
 */

export { loadConfig, findConfig, CONFIG_FILENAME, CONFIG_DIRECTORY, CONFIG_VERSION } from './config.ts'
export type { SoffitConfig } from './config.ts'

export { runPipeline } from './pipeline.ts'
export type { PipelineConfig, PipelineResult } from './pipeline.ts'

export { pipelineConfig } from './preset.ts'

export { exitCodeFor, renderReport } from './report.ts'

export { relationshipId, findingId, namespaced } from './ids.ts'

export {
  OBSERVATION_KINDS,
  REF_KINDS,
  isStandardObservationKind,
  type ObservationKind,
  type RefKind,
} from './kinds.ts'

export { architectureRules, EVIDENCE_LIMIT } from './providers/architecture-rules.ts'
export { sourceRoot, ownerOf } from './providers/source-root.ts'
export { typescriptImports } from './providers/typescript-imports.ts'

export type {
  Association,
  Evidence,
  Finding,
  JsonObject,
  JsonValue,
  LikeC4Model,
  NamedProvider,
  Observation,
  Ref,
  ResolveContext,
  ResolveProvider,
  ScanContext,
  ScanProvider,
  Severity,
  ValidateContext,
  ValidateProvider,
} from './types.ts'
