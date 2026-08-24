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
  resolveConfig,
  defineConfig,
  findConfig,
  CONFIG_FILENAME,
  CONFIG_FILENAMES,
  CONFIG_DIRECTORY,
  CONFIG_VERSION,
} from './config.ts'
export type { FitC4FileConfig, ResolvedConfig } from './config.ts'

export {
  init,
  INIT_AGENTS,
  MODEL_DIR,
  MODEL_FILENAME,
  type InitAgent,
  type InitOptions,
  type InitResult,
} from './init.ts'

export {
  draft,
  type DraftDescribe,
  type DraftElementFacts,
  type DraftOptions,
  type DraftResult,
} from './draft.ts'

export { runPipeline } from './pipeline.ts'
export type { PhaseProviders, PipelineConfig, PipelineResult } from './pipeline.ts'

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

// The providers a config composes into its phase arrays, plus the ids each
// one runs under, so a report line can be traced back to what emitted it.
export {
  architectureRules,
  ARCHITECTURE_RULE_IDS,
  DEFAULT_DRIFT_TAG,
  EVIDENCE_LIMIT,
  PROVIDER_ID as ARCHITECTURE_RULES_PROVIDER_ID,
} from './providers/architecture-rules.ts'
export type {
  ArchitectureRuleId,
  ArchitectureRulesOptions,
  TypeOnlyImportsPolicy,
} from './providers/architecture-rules.ts'
export {
  importScan,
  IMPORT_SCAN_EXTENSIONS,
  PROVIDER_ID as IMPORT_SCAN_PROVIDER_ID,
} from './providers/import-scan.ts'
export type { ImportScanOptions } from './providers/import-scan.ts'
export {
  missingDescriptions,
  PROVIDER_ID as MISSING_DESCRIPTIONS_PROVIDER_ID,
} from './providers/missing-descriptions.ts'
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
  Progress,
  Ref,
  ResolveContext,
  ResolveProvider,
  ScanContext,
  ScanProvider,
  Severity,
  ValidateContext,
  ValidateProvider,
} from './types.ts'
