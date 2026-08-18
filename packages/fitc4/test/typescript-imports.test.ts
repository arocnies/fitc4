/**
 * The scanner's skip rules decide what is under architecture control at all.
 * Silent coverage loss is this project's core fear — a directory quietly
 * dropped from the walk is a boundary crossing nobody checks — so every skip
 * (and every deliberate non-skip) is pinned here.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { PipelineResult } from '../src/pipeline.ts'
import { enumerateSources, isTestPath, typescriptImports } from '../src/providers/typescript-imports.ts'
import { findingFor, runFixture } from './helpers.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** A scratch repository built from `files` (paths relative to its root). */
function scratchRepo(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-scan-'))
  roots.push(root)
  for (const relative of files) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, 'export {}\n')
  }
  return root
}

describe('isTestPath', () => {
  test.each([
    'src/thing.test.ts',
    'src/thing.spec.ts',
    'src/thing.test.tsx',
    'src/thing.spec.mts',
    'src/thing.TEST.ts',
    'src/__tests__/thing.ts',
    'src/__mocks__/thing.ts',
    'src/test/thing.ts',
    'src/tests/deep/thing.ts',
    'src/spec/thing.ts',
    'specs/thing.ts',
  ])('%s is a test path', (relative) => {
    expect(isTestPath(relative)).toBe(true)
  })

  test.each([
    'src/thing.ts',
    'src/contest.ts',
    // Only whole segments count: a directory merely containing 'test' is source.
    'src/latest/thing.ts',
    'src/testing/thing.ts',
    'src/protest/thing.ts',
    // Only the directory segments count, not the file's own name.
    'src/tests.ts',
  ])('%s is source', (relative) => {
    expect(isTestPath(relative)).toBe(false)
  })
})

describe('enumerateSources skip rules', () => {
  test('build output is skipped only at the repository root', () => {
    const root = scratchRepo([
      'dist/generated.ts',
      'build/generated.ts',
      'out/generated.ts',
      'coverage/generated.ts',
      // The same names nested under a source tree are legitimate source
      // directories; dropping them would silently shrink coverage.
      'src/dist/kept.ts',
      'src/out/kept.ts',
      'src/main.ts',
    ])

    expect(enumerateSources(root, ['.'])).toEqual([
      'src/dist/kept.ts',
      'src/main.ts',
      'src/out/kept.ts',
    ])
  })

  test('node_modules is skipped at any depth', () => {
    const root = scratchRepo([
      'node_modules/pkg/index.ts',
      'src/nested/node_modules/pkg/index.ts',
      'src/main.ts',
    ])

    expect(enumerateSources(root, ['.'])).toEqual(['src/main.ts'])
  })

  test('dotfiles and dot-directories are skipped at any depth', () => {
    const root = scratchRepo([
      '.hidden.ts',
      '.config/tool.ts',
      'src/.cache/entry.ts',
      'src/.skipped.ts',
      'src/main.ts',
    ])

    expect(enumerateSources(root, ['.'])).toEqual(['src/main.ts'])
  })

  test('only source extensions are enumerated', () => {
    const root = scratchRepo(['src/main.ts', 'src/view.tsx', 'src/mod.mts', 'src/legacy.cts'])
    fs.writeFileSync(path.join(root, 'src', 'notes.md'), '# notes\n')
    fs.writeFileSync(path.join(root, 'src', 'script.js'), 'export {}\n')

    expect(enumerateSources(root, ['src'])).toEqual([
      'src/legacy.cts',
      'src/main.ts',
      'src/mod.mts',
      'src/view.tsx',
    ])
  })
})

describe('the scan provider over the skip rules', () => {
  test('test files are enumerated for coverage but never become file observations', async () => {
    const root = scratchRepo([
      'src/main.ts',
      'src/main.test.ts',
      'src/__tests__/helper.ts',
    ])
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n')

    const scan = typescriptImports({
      tsconfigPath: path.join(root, 'tsconfig.json'),
      roots: ['src'],
    })
    const observations = await scan({ repositoryRoot: root })

    const files = observations
      .filter((observation) => observation.kind === 'file')
      .map((observation) => observation.subject?.id)
    expect(files).toEqual(['src/main.ts'])
  })
})

describe('module reference forms', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('imports')
  })

  test('every static and dynamic form is observed', () => {
    const kinds = result.observations
      .filter((item) => item.kind === 'dependency' && item.target?.kind === 'file')
      .map((item) => item.data?.['dependencyKind'])

    expect(new Set(kinds)).toEqual(new Set(['import', 're-export', 'dynamic-import', 'require']))
  })

  // Lazy-loading across a boundary is the standard way to break a static
  // cycle, so it must not escape the check.
  test('a dynamic import is a real dependency', () => {
    const dynamic = result.observations.find(
      (item) => item.data?.['dependencyKind'] === 'dynamic-import',
    )
    expect(dynamic?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  test('import.meta.resolve is a dependency', () => {
    const meta = result.observations.find(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/interface/meta.ts',
    )
    expect(meta?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  // Two references to one specifier can share a line; keying only on the line
  // made the scanner emit duplicate ids and fail itself.
  test('two references on one line do not collide', () => {
    expect(result.findings.filter((finding) => finding.ruleId === 'provider-failure')).toEqual([])

    const sameLine = result.observations.filter(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/interface/sameline.ts',
    )
    expect(sameLine).toHaveLength(2)
    expect(new Set(sameLine.map((item) => item.id)).size).toBe(2)
  })

  test('repeated references to one target keep their own evidence lines', () => {
    const { observations } = result

    const toCore = observations.filter(
      (item) =>
        item.kind === 'dependency' &&
        item.subject?.id === 'src/interface/index.ts' &&
        item.target?.id === 'src/core/health.ts',
    )
    const lines = toCore.map((item) => item.evidence?.[0]?.line)

    expect(lines.length).toBeGreaterThan(3)
    expect(new Set(lines).size).toBe(lines.length)
    expect(new Set(observations.map((item) => item.id)).size).toBe(observations.length)
  })

  // Classifying a broken relative import as an external package would silently
  // drop the dependency from the architecture check.
  test('an unresolvable relative import is reported, not treated as a package', () => {
    const { observations, findings } = result

    const broken = observations.find((item) => item.kind === 'unresolved-dependency')
    expect(broken?.target?.id).toBe('./deleted.js')
    // An external specifier is a module too — only the observation kind
    // separates "could not resolve this" from "resolves outside the model".
    expect(broken?.target?.kind).toBe('module')

    const finding = findingFor(findings, 'unresolved-import')
    expect(finding?.severity).toBe('warning')
    expect(finding?.subject?.id).toBe('src/interface/broken.ts')
  })
})
