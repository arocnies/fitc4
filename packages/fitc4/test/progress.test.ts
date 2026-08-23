/**
 * The narration layer is advisory output only: it must report the run in
 * order, and it must never change the run. Both halves are pinned here — the
 * exact message sequence, the provider-prefixed context hook, and the
 * result's independence from whether anyone is listening.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import type { ResolvedConfig } from '../src/config.ts'
import { draft } from '../src/draft.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import { sourceRoot } from '../src/providers/source-root.ts'
import { typescriptImports } from '../src/providers/typescript-imports.ts'
import type { Observation, ScanContext, ValidateProvider } from '../src/types.ts'
import { fixturePath, runFixture } from './helpers.ts'

const HEAVY = { timeout: 120_000 }

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-progress-'))
  roots.push(root)
  return root
}

describe('pipeline narration', () => {
  test('narrates every phase and provider, in run order', HEAVY, async () => {
    const messages: string[] = []
    await runFixture('ok', { onProgress: (message) => void messages.push(message) })

    expect(messages).toEqual([
      `model: loading ${fixturePath('ok')}`,
      'scan: 1 provider',
      'scan: typescript-imports...',
      expect.stringMatching(/^scan: typescript-imports done, \d+ observations, \d+\.\ds$/),
      'resolve: 1 provider',
      'resolve: source-root...',
      expect.stringMatching(/^resolve: source-root done, \d+ associations, \d+\.\ds$/),
      'validate: 1 provider',
      'validate: architecture-rules...',
      expect.stringMatching(/^validate: architecture-rules done, 0 findings, \d+\.\ds$/),
    ])
  })

  test('an invalid model narrates the stop instead of the phases', HEAVY, async () => {
    const messages: string[] = []
    await runFixture('no-model', { onProgress: (message) => void messages.push(message) })

    expect(messages).toEqual([
      `model: loading ${fixturePath('no-model')}`,
      expect.stringMatching(/^model: invalid, \d+ errors?, stopping$/),
    ])
  })

  test('a failing provider narrates the failure and the run continues', HEAVY, async () => {
    const throwing: ValidateProvider = async () => {
      throw new Error('boom')
    }
    const messages: string[] = []
    const result = await runFixture('ok', {
      validate: [{ id: 'mock-throwing', run: throwing }],
      onProgress: (message) => void messages.push(message),
    })

    expect(messages).toContainEqual(expect.stringMatching(/^validate: mock-throwing failed, \d+\.\ds$/))
    // The narration reported the failure; the finding still carries it.
    expect(result.findings.some((finding) => finding.ruleId === 'provider-failure')).toBe(true)
  })

  // Narration must be pure observation: a listener attached or not, the
  // pipeline result is the same result.
  test('the result is identical with and without narration', HEAVY, async () => {
    const narrated = await runFixture('violations', { onProgress: () => {} })
    const silent = await runFixture('violations')

    expect(JSON.stringify(narrated)).toBe(JSON.stringify(silent))
  })
})

describe('the provider progress hook', () => {
  const observing = async (context: ScanContext): Promise<Observation[]> => {
    context.progress?.('halfway through')
    return [
      {
        id: 'file:src/core/health.ts',
        kind: 'file',
        subject: { kind: 'file', id: 'src/core/health.ts' },
        provider: 'mock-progress-scan',
      },
    ]
  }

  test('is injected prefixed with the provider id, so providers never name themselves', HEAVY, async () => {
    const messages: string[] = []
    await runFixture('ok', {
      scan: [{ id: 'mock-progress-scan', run: observing }],
      onProgress: (message) => void messages.push(message),
    })

    const index = messages.indexOf('mock-progress-scan: halfway through')
    expect(index).toBeGreaterThan(messages.indexOf('scan: mock-progress-scan...'))
    expect(messages[index + 1]).toMatch(/^scan: mock-progress-scan done, /)
  })

  test('is absent when nobody is listening', HEAVY, async () => {
    let seen: unknown = 'unset'
    const capturing = async (context: ScanContext): Promise<Observation[]> => {
      seen = context.progress
      return observing(context)
    }

    await runFixture('ok', { scan: [{ id: 'mock-progress-scan', run: capturing }] })

    expect(seen).toBeUndefined()
  })
})

describe('draft narration', () => {
  test('narrates the scan providers the same way the pipeline does', HEAVY, async () => {
    const root = fixturePath('drift')
    const config: ResolvedConfig = {
      repositoryRoot: root,
      modelDir: scratch(),
      scan: [typescriptImports({ tsconfig: path.join(root, 'tsconfig.json'), roots: ['src'] })],
      resolve: [sourceRoot()],
      validate: [architectureRules()],
    }

    const messages: string[] = []
    await draft(config, { onProgress: (message) => void messages.push(message) })

    expect(messages).toEqual([
      'scan: 1 provider',
      'scan: typescript-imports...',
      expect.stringMatching(/^scan: typescript-imports done, \d+ observations, \d+\.\ds$/),
    ])
  })
})
