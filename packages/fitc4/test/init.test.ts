/**
 * `init` is judged by its promise: a scaffolded project's very first check
 * run is green, and nothing that already exists is ever overwritten.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { loadConfig } from '../src/config.ts'
import { pipelineConfig } from '../src/defaults.ts'
import { init } from '../src/init.ts'
import { runPipeline } from '../src/pipeline.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-init-'))
  roots.push(root)
  return root
}

describe('init', () => {
  test('scaffolds a config the loader accepts and a model, and names the gaps', () => {
    const root = scratch()

    const result = init(root)

    expect(result.created).toEqual(['fitc4.config.json', 'arch/model.c4'])
    expect(result.skipped).toEqual([])
    // A fresh directory has neither prerequisite; both are notes, not files —
    // guessing a project's TypeScript setup wrong is worse than asking.
    expect(result.notes.join('\n')).toContain('tsconfig.json')
    expect(result.notes.join('\n')).toContain('src/')

    const config = loadConfig(path.join(root, 'fitc4.config.json'))
    expect(config.scanRoots).toEqual(['src'])
    expect(config.modelDir).toBe(path.join(root, 'arch'))
  })

  test('the first check run on a scaffolded project is green', async () => {
    const root = scratch()
    init(root)

    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const started = true\n')
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    )

    const result = await runPipeline(
      pipelineConfig(loadConfig(path.join(root, 'fitc4.config.json'))),
    )

    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
  })

  test('refuses to run where any config form already exists', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'fitc4.config.ts'), 'export default {}\n')

    expect(() => init(root)).toThrow(/already configured: fitc4\.config\.ts/)
    expect(fs.existsSync(path.join(root, 'fitc4.config.json'))).toBe(false)
  })

  test('keeps an existing model file untouched', () => {
    const root = scratch()
    fs.mkdirSync(path.join(root, 'arch'))
    fs.writeFileSync(path.join(root, 'arch', 'model.c4'), '// authored\n')

    const result = init(root)

    expect(result.created).toEqual(['fitc4.config.json'])
    expect(result.skipped).toEqual(['arch/model.c4'])
    expect(fs.readFileSync(path.join(root, 'arch', 'model.c4'), 'utf8')).toBe('// authored\n')
  })
})
