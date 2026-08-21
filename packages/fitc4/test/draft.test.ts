/**
 * `draft` is judged by its promise: the generated model parses under the
 * bundled likec4, the very first gate run on it is green, and the observed
 * debt shows up as the drift burn-down rather than as errors.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import type { ResolvedConfig } from '../src/config.ts'
import { draft } from '../src/draft.ts'
import { pipelineConfig } from '../src/defaults.ts'
import { runPipeline } from '../src/pipeline.ts'
import type { Observation, ScanContext } from '../src/types.ts'
import { fixturePath, ruleIds } from './helpers.ts'

const HEAVY = { timeout: 120_000 }

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-draft-'))
  roots.push(root)
  return root
}

/** A config pointing at a fixture's sources with a scratch model directory. */
function configFor(fixture: string): ResolvedConfig {
  const root = fixturePath(fixture)
  return {
    repositoryRoot: root,
    modelDir: scratch(),
    scanRoots: ['src'],
    tsconfigPath: path.join(root, 'tsconfig.json'),
  }
}

function errors(findings: { severity: string }[]): unknown[] {
  return findings.filter((finding) => finding.severity === 'error')
}

describe('draft', () => {
  test('drafts one element per directory and gates green with the debt as drift', HEAVY, async () => {
    const config = configFor('drift')
    const result = await draft(config)

    expect(result.written).toBe(path.join(config.modelDir, 'model.c4'))
    expect(result.refusal).toBeUndefined()
    expect(result.elements).toBe(3)
    expect(result.edges).toBe(2)
    expect(result.packages).toBe(0)

    // One element per first-level directory, each claiming its prefix, each
    // with a placeholder description in init's TODO style.
    expect(result.text).toContain(`sources 'src/core/**'`)
    expect(result.text).toContain(`sources 'src/interface/**'`)
    expect(result.text).toContain(`sources 'src/legacy/**'`)
    expect(result.text).toContain('TODO: what is this component responsible for?')
    // No files sit directly in src/, so no catch-all element appears.
    expect(result.text).not.toContain(`sources 'src/**'`)
    // No external packages observed, so no stub element appears.
    expect(result.text).not.toContain('packages')
    // The dependency count rides a trailing comment, correctly pluralized.
    expect(result.text).toContain('app.interface -> app.core { #drift } // 1 dependency')
    expect(result.text).toContain('app.legacy -> app.core { #drift } // 2 dependencies')

    // The proof: the real pipeline on the drafted model is green, and every
    // observed crossing is a counted drift edge rather than an error.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(2)
    expect(gate.findings.filter((finding) => finding.ruleId === 'unused-drift')).toEqual([])
  })

  test('claims observed external packages on one stub element', HEAVY, async () => {
    const config = configFor('packages')
    const result = await draft(config)

    expect(result.elements).toBe(4)
    expect(result.edges).toBe(3)
    expect(result.packages).toBe(4)
    expect(result.text).toContain(
      `packages ['@aws-sdk/client-s3', 'lodash', 'oldpkg', 'pg']`,
    )
    expect(result.text).toContain('vendor = component')

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // Every element-to-package crossing is a drift edge; the resolve tier is
    // quiet, so no unmatched or ambiguous package rule fires.
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(3)
    expect(ruleIds(gate.findings)).toEqual(['drift-relationship'])
  })

  test('files directly in a scan root get one catch-all element', HEAVY, async () => {
    const config = configFor('external')
    const result = await draft(config)

    // src/ holds only root-level files: one catch-all element claiming the
    // root, plus the package stub.
    expect(result.elements).toBe(2)
    expect(result.text).toContain(`src = component 'src'`)
    expect(result.text).toContain(`sources 'src/**'`)
    expect(result.text).toContain(`packages ['amqplib', 'stripe']`)

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // The fixture's broken import stays a warning; it is not the draft's to fix.
    expect(ruleIds(gate.findings)).toEqual(['drift-relationship', 'unresolved-import'])
  })

  test('--no-drift emits plain relationships and still gates green', HEAVY, async () => {
    const config = configFor('drift')
    const result = await draft(config, { drift: false })

    expect(result.text).not.toContain('#drift')
    expect(result.text).not.toContain('tag drift')
    expect(result.text).toContain('app.legacy -> app.core // 2 dependencies')

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // Plain relationships mean no burn-down: the debt is blessed, not counted.
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toEqual([])
  })

  test('refuses to write where any model file already exists', HEAVY, async () => {
    const config = configFor('drift')
    fs.writeFileSync(path.join(config.modelDir, 'authored.c4'), '// authored\n')

    const result = await draft(config)

    expect(result.written).toBeUndefined()
    expect(result.refusal).toContain('authored.c4')
    expect(result.refusal).toContain('never overwrites')
    // The draft is still produced for stdout; the authored file is untouched
    // and nothing new appeared beside it.
    expect(result.text).toContain('app.legacy -> app.core')
    expect(fs.readFileSync(path.join(config.modelDir, 'authored.c4'), 'utf8')).toBe('// authored\n')
    expect(fs.readdirSync(config.modelDir)).toEqual(['authored.c4'])
  })

  test('consumes observations from any configured scan provider', HEAVY, async () => {
    // A deterministic stand-in for dependency-cruiser or an agent scanner:
    // draft reads the observation contract, not TypeScript specifics.
    const observations: Observation[] = [
      { id: 'file:src/views/page.ts', kind: 'file', subject: { kind: 'file', id: 'src/views/page.ts' }, provider: 'stub' },
      { id: 'file:src/api/server.ts', kind: 'file', subject: { kind: 'file', id: 'src/api/server.ts' }, provider: 'stub' },
      {
        id: 'dep:1',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/views/page.ts' },
        target: { kind: 'file', id: 'src/api/server.ts' },
        provider: 'stub',
      },
      {
        id: 'dep:2',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/api/server.ts' },
        target: { kind: 'module', id: 'fastify' },
        provider: 'stub',
      },
      {
        id: 'dep:3',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/api/server.ts' },
        target: { kind: 'module', id: 'node:fs' },
        provider: 'stub',
      },
    ]
    const config: ResolvedConfig = {
      ...configFor('drift'),
      providers: {
        scan: [{ id: 'stub', run: async (_context: ScanContext) => observations }],
      },
    }

    const result = await draft(config)

    // `views` is a directory name LikeC4's grammar reserves; the identifier is
    // mangled while the title keeps the observed name.
    expect(result.text).toContain(`views_ = component 'views'`)
    expect(result.text).toContain(`sources 'src/views/**'`)
    expect(result.text).toContain('app.views_ -> app.api { #drift } // 1 dependency')
    // Builtins are not packages; only fastify is claimed.
    expect(result.text).toContain(`packages ['fastify']`)
    expect(result.packages).toBe(1)
    expect(result.edges).toBe(2)

    // The mangled identifier still parses and the stub-scanned gate is green.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
  })
})
