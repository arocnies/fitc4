/**
 * The `fitc4` library entry point.
 *
 * The CLI in `cli.ts` is one caller of these exports, not a layer above them.
 * Anything it can do is reachable here, so a host project can run the pipeline
 * inside its own test suite instead of shelling out.
 *
 * Providers are exported individually rather than behind a registry. Composing
 * them is the caller's job, in code or in a `fitc4.config.ts`, and a
 * caller that wants a different scanner supplies a function.
 */

export {
  loadConfig,
  resolveConfig,
  defineConfig,
  findConfig,
  CONFIG_FILENAME,
  CONFIG_FILENAMES,
  CONFIG_DIRECTORY,
  CONFIG_VERSION,
} from './config.ts'
export type { FitC4Config, FitC4FileConfig, ResolvedConfig } from './config.ts'

export { init, MODEL_DIR, MODEL_FILENAME, type InitResult } from './init.ts'

export { runPipeline } from './pipeline.ts'
export type { PhaseProviders, PipelineConfig, PipelineResult } from './pipeline.ts'

export { pipelineConfig, defaultResolve, defaultValidate } from './defaults.ts'

export { exitCodeFor, renderReport, UNMAPPED_SOURCE_GROUP_THRESHOLD } from './report.ts'

export { relationshipId, findingId, namespaced } from './ids.ts'

export { viewerLink, viewIdFor, withViewerLinks, INDEX_VIEW_ID } from './viewer.ts'

export {
  OBSERVATION_KINDS,
  REF_KINDS,
  isStandardObservationKind,
  type ObservationKind,
  type RefKind,
} from './kinds.ts'

// The ids the default composition runs each provider under, exported so a
// config file that replaces a phase can rebuild the default entries verbatim.
export {
  architectureRules,
  DEFAULT_DRIFT_TAG,
  EVIDENCE_LIMIT,
  PROVIDER_ID as ARCHITECTURE_RULES_PROVIDER_ID,
} from './providers/architecture-rules.ts'
export type {
  ArchitectureRuleId,
  ArchitectureRulesOptions,
  TypeOnlyImportsPolicy,
} from './providers/architecture-rules.ts'
export { sourceRoot, ownerOf, PROVIDER_ID as SOURCE_ROOT_PROVIDER_ID } from './providers/source-root.ts'
export {
  typescriptImports,
  PROVIDER_ID as TYPESCRIPT_IMPORTS_PROVIDER_ID,
} from './providers/typescript-imports.ts'
export type { TypeScriptImportsOptions } from './providers/typescript-imports.ts'

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
