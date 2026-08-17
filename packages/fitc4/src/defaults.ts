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
import type { NamedProvider, ResolveProvider, ValidateProvider } from './types.ts'

/**
 * The default resolve and validate phases, ready to spread.
 *
 * Exported so a config that extends a phase writes
 * `validate: [...defaultValidate, myProvider]` — additive intent as additive
 * code. Rebuilding the entries by hand works too, but forgetting to is the
 * config-file way to silently drop the standard rules, and a gate with no
 * rules passes everything. Scan has no array export because its provider is
 * built from config values; rebuild it with
 * `typescriptImports({ tsconfigPath, roots })` under
 * `TYPESCRIPT_IMPORTS_PROVIDER_ID`.
 */
export const defaultResolve: NamedProvider<ResolveProvider>[] = [
  { id: SOURCE_ROOT_ID, run: sourceRoot },
]

export const defaultValidate: NamedProvider<ValidateProvider>[] = [
  { id: RULES_ID, run: architectureRules },
]

/**
 * Compose the providers around a resolved config.
 *
 * A phase array present in the config replaces the defaults for that phase
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
    resolve: config.providers?.resolve ?? [...defaultResolve],
    validate: config.providers?.validate ?? [...defaultValidate],
  }
}
