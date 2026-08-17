/**
 * The default provider composition.
 *
 * Separate from `cli.ts` because that module runs the pipeline on import. A
 * library consumer needs the composition without the side effect, and the CLI
 * is then just one caller of it.
 *
 * Providers remain plain functions composed into phase arrays. A config file
 * may supply those arrays; there is still no registry, lifecycle, or
 * discovery system. A caller wanting something this cannot express builds its
 * own `PipelineConfig`.
 */

import type { ResolvedConfig } from './config.ts'
import type { PipelineConfig } from './pipeline.ts'
import { architectureRules, PROVIDER_ID as RULES_ID } from './providers/architecture-rules.ts'
import { sourceRoot, PROVIDER_ID as SOURCE_ROOT_ID } from './providers/source-root.ts'
import {
  typescriptImports,
  PROVIDER_ID as TYPESCRIPT_IMPORTS_ID,
} from './providers/typescript-imports.ts'

/**
 * Compose the providers around a resolved config.
 *
 * A phase array present in the config replaces the preset for that phase
 * entirely: present replaces, absent defaults — merge semantics are the
 * user's job, in their config file, where they can see them.
 */
export function pipelineConfig(config: ResolvedConfig): PipelineConfig {
  return {
    repositoryRoot: config.repositoryRoot,
    modelDir: config.modelDir,
    scan: config.providers?.scan ?? [
      {
        id: TYPESCRIPT_IMPORTS_ID,
        run: typescriptImports({
          tsconfigPath: config.tsconfigPath,
          roots: config.scanRoots,
        }),
      },
    ],
    resolve: config.providers?.resolve ?? [{ id: SOURCE_ROOT_ID, run: sourceRoot }],
    validate: config.providers?.validate ?? [{ id: RULES_ID, run: architectureRules }],
  }
}
