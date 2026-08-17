/**
 * The default provider composition.
 *
 * Separate from `cli.ts` because that module runs the pipeline on import. A
 * library consumer needs the composition without the side effect, and the CLI
 * is then just one caller of it.
 *
 * Which providers run is still code, not configuration (POC-DESIGN-v4 defers
 * command providers). A caller wanting a different scanner builds its own
 * `PipelineConfig`; this is the batteries-included default, not a registry.
 */

import type { SoffitConfig } from './config.ts'
import type { PipelineConfig } from './pipeline.ts'
import { architectureRules, PROVIDER_ID as RULES_ID } from './providers/architecture-rules.ts'
import { sourceRoot, PROVIDER_ID as SOURCE_ROOT_ID } from './providers/source-root.ts'
import {
  typescriptImports,
  PROVIDER_ID as TYPESCRIPT_IMPORTS_ID,
} from './providers/typescript-imports.ts'

/** Compose the standard providers around a loaded config. */
export function pipelineConfig(config: SoffitConfig): PipelineConfig {
  return {
    repositoryRoot: config.repositoryRoot,
    modelDir: config.modelDir,
    scan: [
      {
        id: TYPESCRIPT_IMPORTS_ID,
        run: typescriptImports({
          tsconfigPath: config.tsconfigPath,
          roots: config.scanRoots,
        }),
      },
    ],
    resolve: [{ id: SOURCE_ROOT_ID, run: sourceRoot }],
    validate: [{ id: RULES_ID, run: architectureRules }],
  }
}
