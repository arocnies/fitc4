/**
 * The scanner's skip rules decide what is under architecture control at all.
 * Silent coverage loss is this project's core fear — a directory quietly
 * dropped from the walk is a boundary crossing nobody checks — so every skip
 * (and every deliberate non-skip) is pinned here.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { enumerateSources, isTestPath, typescriptImports } from '../src/providers/typescript-imports.ts'

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
