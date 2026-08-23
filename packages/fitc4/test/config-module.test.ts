/**
 * Loading config modules: every extension, real providers, custom providers,
 * and the agent exec. The pipeline runs exactly what the file names — there
 * is no default composition to fall back to and none is composed in.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

import { findConfig, resolveConfig } from '../src/config.ts'
import { runPipeline } from '../src/pipeline.ts'
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

/** The real entry module, importable from a temp dir outside node_modules. */
const INDEX_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'index.ts')).href

/**
 * A config module pointing at a fixture by absolute path, with the standard
 * phases written out the way a real config writes them. `extra` fields land
 * after the phases; a duplicate key in `extra` (say a second `validate:`)
 * overrides the standard one, which is how tests swap a phase.
 */
function moduleSource(fixture: string, extra = ''): string {
  const root = fixturePath(fixture)
  return `import { architectureRules, sourceRoot, typescriptImports } from ${JSON.stringify(INDEX_URL)}
export default {
  version: 1,
  repositoryRoot: ${JSON.stringify(root)},
  model: ${JSON.stringify(root)},
  scan: [typescriptImports({ tsconfig: ${JSON.stringify(path.join(root, 'tsconfig.json'))}, roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
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

    const result = await runPipeline(await resolveConfig(configPath))

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['custom/advice'])
    expect(result.findings[0]?.provider).toBe('custom-advice')
    // The scan and resolve phases the file names still ran.
    expect(result.observations.length).toBeGreaterThan(0)
    expect(result.associations.length).toBeGreaterThan(0)
    expect(renderReport(result).exitCode).toBe(0)
  })

  // The whole semantics in one assertion: the fixture contradicts its model,
  // and none of that is reported, because the file's validate phase is the
  // gate — nothing standard is composed in behind it.
  test('the gate runs exactly the validate providers the file names', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.ts',
      moduleSource('violations', CUSTOM_VALIDATE),
    )

    const result = await runPipeline(await resolveConfig(configPath))

    expect(ruleIds(result.findings)).toEqual(['custom/advice'])
  })
})

describe('a .js config module', () => {
  test('loads and its provider runs', async () => {
    const source = moduleSource('ok', CUSTOM_VALIDATE).replace(': string', '')
    const configPath = writeConfigFile('fitc4.config.js', source)

    const result = await runPipeline(await resolveConfig(configPath))

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['custom/advice'])
  })
})

// Whichever file lost a silent tiebreak would be a silently ignored config —
// indistinguishable from a config that is honored.
describe('two configs in one directory', () => {
  test('is an error naming both files', () => {
    const tsPath = writeConfigFile('fitc4.config.ts', moduleSource('ok'))
    const jsPath = path.join(path.dirname(tsPath), 'fitc4.config.js')
    fs.writeFileSync(jsPath, 'export default {}\n')

    expect(() => findConfig(path.dirname(tsPath))).toThrow(tsPath)
    expect(() => findConfig(path.dirname(tsPath))).toThrow(jsPath)
  })
})

describe('rejecting a malformed config module', () => {
  test('a missing default export is an error', async () => {
    const configPath = writeConfigFile('fitc4.config.js', 'export const config = {}\n')

    await expect(resolveConfig(configPath)).rejects.toThrow('default export')
  })

  test.each([
    ['a string', 'export default "not a config"\n'],
    ['an array', 'export default []\n'],
  ])('a non-object default export (%s) is an error', async (_label, source) => {
    const configPath = writeConfigFile('fitc4.config.js', source)

    await expect(resolveConfig(configPath)).rejects.toThrow(
      'the default export must be a config object',
    )
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
    const configPath = writeConfigFile('fitc4.config.js', moduleSource('ok', '  resolve: {},\n'))

    await expect(resolveConfig(configPath)).rejects.toThrow("'resolve' must be an array")
  })

  // The module form is validated even though a compiler may have seen the
  // file: nothing forces the author to run one.
  test('the shared fields are validated at load time', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource('ok').replace('version: 1', 'version: 2'),
    )

    await expect(resolveConfig(configPath)).rejects.toThrow('unsupported version')
  })
})

describe('the other extensions', () => {
  // The .mts form exists for CommonJS packages: a plain .ts config loads as
  // an ES module, and Node's own error for that case recommends exactly this
  // extension — which must therefore be discoverable, not a dead end.
  test('a .mts config is discovered and loads', async () => {
    const directory = tempDir()
    fs.writeFileSync(path.join(directory, 'fitc4.config.mts'), moduleSource('ok'))

    const found = findConfig(directory)
    expect(path.basename(found)).toBe('fitc4.config.mts')

    const config = await resolveConfig(found)
    expect(config.scan.map((provider) => provider.id)).toEqual(['typescript-imports'])
  })

  // The plain-JS counterpart of .mts, for CommonJS packages that also skip
  // the type-stripping step.
  test('a .mjs config is discovered and loads', async () => {
    const directory = tempDir()
    fs.writeFileSync(
      path.join(directory, 'fitc4.config.mjs'),
      moduleSource('ok', CUSTOM_VALIDATE).replace(': string', ''),
    )

    const found = findConfig(directory)
    expect(path.basename(found)).toBe('fitc4.config.mjs')

    const result = await runPipeline(await resolveConfig(found))
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['custom/advice'])
  })
})

describe('the agent exec', () => {
  test('a config with an agent exec carries it on the resolved config', async () => {
    const configPath = writeConfigFile(
      'fitc4.config.js',
      moduleSource(
        'ok',
        `  agent: { id: 'stub/model', run: async () => ({ ok: false, error: 'never called' }) },\n`,
      ),
    )

    const resolved = await resolveConfig(configPath)

    expect(resolved.agent?.id).toBe('stub/model')
    expect(typeof resolved.agent?.run).toBe('function')
  })

  // The same structural strictness as the provider arrays: a malformed exec is
  // the config's error to fix here, not a crash inside whatever command first
  // calls it.
  test.each([
    ['a non-object', `  agent: 'claude',\n`],
    ['a missing run function', `  agent: { id: 'stub' },\n`],
    ['a blank id', `  agent: { id: ' ', run: async () => ({ ok: false, error: 'x' }) },\n`],
  ])('an agent exec that is %s is an error', async (_label, extra) => {
    const configPath = writeConfigFile('fitc4.config.js', moduleSource('ok', extra))

    await expect(resolveConfig(configPath)).rejects.toThrow(
      "'agent' must be an agent exec with a string 'id' and a function 'run'",
    )
  })
})
