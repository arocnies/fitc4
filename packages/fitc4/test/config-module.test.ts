import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { findConfig, loadConfig, resolveConfig } from '../src/config.ts'
import { runPipeline } from '../src/pipeline.ts'
import { pipelineConfig } from '../src/defaults.ts'
import { renderReport } from '../src/report.ts'
import { fixturePath, ruleIds } from './helpers.ts'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-config-module-'))
  created.push(directory)
  return directory
}

function writeConfigFile(filename: string, source: string): string {
  const configPath = path.join(tempDir(), filename)
  fs.writeFileSync(configPath, source)
  return configPath
}

/**
 * A config module pointing at a fixture by absolute path, so the temp
 * directory needs no source tree of its own.
 */
function moduleSource(fixture: string, extra = ''): string {
  const root = fixturePath(fixture)
  return `export default {
  version: 1,
  repositoryRoot: ${JSON.stringify(root)},
  model: ${JSON.stringify(root)},
  scanRoots: ['src'],
  tsconfig: ${JSON.stringify(path.join(root, 'tsconfig.json'))},
${extra}}
`
}

// The type annotation is the point: it only imports if types are stripped,
// under vitest and under plain node alike.
const CUSTOM_VALIDATE = `  validate: [
    {
      id: 'custom-advice',
      run: async () => {
        const description: string = 'custom provider ran'
        return [
          {
            id: 'advice',
            ruleId: 'custom/advice',
            severity: 'info',
            description,
            provider: 'custom-advice',
          },
        ]
      },
    },
  ],
`

describe('a .ts config module', () => {
  test('is discovered and its custom validate provider runs', async () => {
    const configPath = writeConfigFile('fitc4.config.ts', moduleSource('ok', CUSTOM_VALIDATE))

    expect(findConfig(path.dirname(configPath))).toBe(configPath)

    const result = await runPipeline(pipelineConfig(await resolveConfig(configPath)))

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['custom/advice'])
    expect(result.findings[0]?.provider).toBe('custom-advice')
    // The scan and resolve phases were absent from the config, so the defaults
    // still supplied them.
    expect(result.observations.length).toBeGreaterThan(0)
    expect(result.associations.length).toBeGreaterThan(0)
    expect(renderReport(result).exitCode).toBe(0)
  })

  // The whole semantics in one assertion: the fixture contradicts its model,
  // and none of that is reported, because a present phase replaces the defaults.
  test('a present phase replaces the defaults for that phase entirely', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.ts',
      moduleSource('violations', CUSTOM_VALIDATE),
    )

    const result = await runPipeline(pipelineConfig(await resolveConfig(configPath)))

    expect(ruleIds(result.findings)).toEqual(['custom/advice'])
  })
})

describe('a .js config module', () => {
  test('loads and its provider runs', async () => {
    const source = moduleSource('ok', CUSTOM_VALIDATE).replace(': string', '')
    const configPath = writeConfigFile('fitc4.config.js', source)

    const result = await runPipeline(pipelineConfig(await resolveConfig(configPath)))

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['custom/advice'])
  })
})

// Whichever file lost a silent tiebreak would be a silently ignored config —
// indistinguishable from a config that is honored.
describe('two configs in one directory', () => {
  test('is an error naming both files', () => {
    const tsPath = writeConfigFile('fitc4.config.ts', moduleSource('ok'))
    const jsonPath = path.join(path.dirname(tsPath), 'fitc4.config.json')
    fs.writeFileSync(jsonPath, '{}')

    expect(() => findConfig(path.dirname(tsPath))).toThrow(tsPath)
    expect(() => findConfig(path.dirname(tsPath))).toThrow(jsonPath)
  })
})

describe('rejecting a malformed config module', () => {
  test('a missing default export is an error', async () => {
    const configPath = writeConfigFile('fitc4.config.js', 'export const config = {}\n')

    await expect(resolveConfig(configPath)).rejects.toThrow('default export')
  })

  test('a provider entry without a run function is an error naming the entry', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource('ok', "  validate: [{ id: 'no-run' }],\n"),
    )

    await expect(resolveConfig(configPath)).rejects.toThrow("'validate[0]'")
  })

  test('a provider entry without an id is an error naming the entry', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource('ok', '  scan: [{ run: async () => [] }],\n'),
    )

    await expect(resolveConfig(configPath)).rejects.toThrow("'scan[0]'")
  })

  test('a non-array phase is an error', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource('ok', '  resolve: {},\n'),
    )

    await expect(resolveConfig(configPath)).rejects.toThrow("'resolve' must be an array")
  })

  // The module form gets the same strictness as JSON: a compiler may have
  // seen the file, but nothing forces the author to run one.
  test('the shared fields are validated as strictly as JSON', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource('ok').replace('version: 1', 'version: 2'),
    )

    await expect(resolveConfig(configPath)).rejects.toThrow('unsupported version')
  })
})

describe('the JSON path through resolveConfig', () => {
  test('matches loadConfig and carries no providers', async () => {
    const root = fixturePath('ok')
    const configPath = path.join(tempDir(), 'fitc4.config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repositoryRoot: root,
        model: root,
        scanRoots: ['src'],
        tsconfig: path.join(root, 'tsconfig.json'),
      }),
    )

    const resolved = await resolveConfig(configPath)

    expect(resolved).toEqual(loadConfig(configPath))
    expect(resolved.providers).toBeUndefined()
  })
})
