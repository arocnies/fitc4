import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPipeline, type PipelineConfig, type PipelineResult } from '../src/pipeline.ts'
import { architectureRules, PROVIDER_ID as RULES_ID } from '../src/providers/architecture-rules.ts'
import { sourceRoot, PROVIDER_ID as SOURCE_ROOT_ID } from '../src/providers/source-root.ts'
import {
  typescriptImports,
  PROVIDER_ID as TYPESCRIPT_IMPORTS_ID,
} from '../src/providers/typescript-imports.ts'
import type { Finding } from '../src/types.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

export { RULES_ID, SOURCE_ROOT_ID, TYPESCRIPT_IMPORTS_ID }

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name)
}

export function fixtureConfig(
  name: string,
  overrides: Partial<PipelineConfig> = {},
  roots: string[] = ['src'],
): PipelineConfig {
  const root = fixturePath(name)
  return {
    repositoryRoot: root,
    modelDir: root,
    scan: [
      {
        id: TYPESCRIPT_IMPORTS_ID,
        run: typescriptImports({ tsconfigPath: path.join(root, 'tsconfig.json'), roots }),
      },
    ],
    resolve: [{ id: SOURCE_ROOT_ID, run: sourceRoot }],
    validate: [architectureRules()],
    ...overrides,
  }
}

export function runFixture(
  name: string,
  overrides: Partial<PipelineConfig> = {},
  roots?: string[],
): Promise<PipelineResult> {
  return runPipeline(fixtureConfig(name, overrides, roots))
}

export function ruleIds(findings: Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.ruleId))].sort()
}

export function findingFor(findings: Finding[], ruleId: string): Finding | undefined {
  return findings.find((finding) => finding.ruleId === ruleId)
}
