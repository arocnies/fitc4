/**
 * Field validation and discovery for the one config form.
 *
 * A config that quietly fell back to anything would scan the wrong tree and
 * report a clean pass — the same fail-open the pipeline avoids everywhere
 * else — so every malformed shape here must be a named error.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { CONFIG_DIRECTORY, CONFIG_FILENAME, findConfig, resolveConfig } from '../src/config.ts'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** Inline stub providers: these tests validate shape, never run a pipeline. */
const STUB_PHASES = `  scan: [{ id: 'stub-scan', run: async () => [] }],
  resolve: [{ id: 'stub-resolve', run: async () => [] }],
  validate: [{ id: 'stub-validate', run: async () => [] }],`

const VALID_FIELDS = `  version: 1,
  repositoryRoot: '..',
  model: '.',
${STUB_PHASES}`

function writeConfig(fields: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-config-'))
  created.push(directory)
  const configPath = path.join(directory, CONFIG_FILENAME)
  fs.writeFileSync(configPath, `export default {\n${fields}\n}\n`)
  return configPath
}

describe('loading the config', () => {
  test('resolves every path relative to the config file', async () => {
    const configPath = writeConfig(VALID_FIELDS)
    const base = path.dirname(configPath)
    const config = await resolveConfig(configPath)

    expect(config.repositoryRoot).toBe(path.resolve(base, '..'))
    expect(config.modelDir).toBe(path.resolve(base, '.'))
    expect(config.scan.map((provider) => provider.id)).toEqual(['stub-scan'])
  })

  // The viewer base names a published site, so it must not be path-resolved,
  // and its absence is the feature being off, not a default.
  test('keeps viewerBaseUrl verbatim and optional', async () => {
    expect((await resolveConfig(writeConfig(VALID_FIELDS))).viewerBaseUrl).toBeUndefined()

    const base = 'https://acme.github.io/arch/#/'
    const config = await resolveConfig(
      writeConfig(`${VALID_FIELDS}\n  viewerBaseUrl: ${JSON.stringify(base)},`),
    )
    expect(config.viewerBaseUrl).toBe(base)
  })

  test.each([
    ['a non-string', '7'],
    ['a blank string', "'  '"],
    ['a relative path', "'./site'"],
    ['a schemeless host', "'acme.github.io/arch'"],
    ['a non-http scheme', "'ftp://acme.github.io/arch'"],
  ])('rejects %s viewerBaseUrl', async (_label, value) => {
    await expect(
      resolveConfig(writeConfig(`${VALID_FIELDS}\n  viewerBaseUrl: ${value},`)),
    ).rejects.toThrow("'viewerBaseUrl' must be an absolute http(s) URL")
  })

  // The shipped example is the only config authored the way a consumer would
  // author one. If its paths stop resolving, the documented layout is wrong.
  // Loading it imports 'fitc4' through the workspace symlink, so this needs a
  // built dist/ — which the test and eval workflow already requires.
  test("the example project's config loads and points at the example", async () => {
    const example = path.resolve(import.meta.dirname, '../../../example')
    const configPath = findConfig(example)

    expect(configPath).toBe(path.join(example, CONFIG_FILENAME))

    const config = await resolveConfig(configPath)
    expect(config.repositoryRoot).toBe(example)
    expect(config.scan.map((provider) => provider.id)).toEqual(['typescript-imports'])
    expect(config.resolve.map((provider) => provider.id)).toEqual(['source-root'])
    expect(config.validate.map((provider) => provider.id)).toEqual(['architecture-rules'])
    expect(fs.existsSync(path.join(config.modelDir, 'model.c4'))).toBe(true)
  })
})

describe('rejecting a malformed config', () => {
  test.each([
    ['a missing version', VALID_FIELDS.replace(/^ {2}version: 1,\n/, ''), "missing required field 'version'"],
    ['a future version', VALID_FIELDS.replace('version: 1', 'version: 2'), 'unsupported version'],
    ['a blank path', VALID_FIELDS.replace("model: '.'", "model: '  '"), "'model' must be a non-empty string"],
  ])('%s is an error', async (_label, fields, expected) => {
    await expect(resolveConfig(writeConfig(fields))).rejects.toThrow(expected)
  })

  // The phases are required, and the missing-phase error carries the standard
  // composition ready to paste: "explicit" must never mean "go find out what
  // the default would have been".
  test.each([
    ['scan', /missing 'scan'.*typescriptImports\(\{ tsconfig: 'tsconfig\.json', roots: \['src'\] \}\)/],
    ['resolve', /missing 'resolve'.*sourceRoot\(\)/],
    ['validate', /missing 'validate'.*architectureRules\(\)/],
  ] as const)('a missing %s phase names the standard one', async (phase, expected) => {
    const fields = VALID_FIELDS.split('\n')
      .filter((line) => !line.trimStart().startsWith(`${phase}: [`))
      .join('\n')
    await expect(resolveConfig(writeConfig(fields))).rejects.toThrow(expected)
  })

  // An empty phase runs nothing: an empty validate is a gate that passes
  // everything, silently.
  test.each(['scan', 'resolve', 'validate'] as const)(
    'an empty %s phase is an error',
    async (phase) => {
      const fields = VALID_FIELDS.replace(new RegExp(`${phase}: \\[.*\\],`), `${phase}: [],`)
      await expect(resolveConfig(writeConfig(fields))).rejects.toThrow(
        `'${phase}' lists no providers`,
      )
    },
  )

  // A typo'd key that is silently ignored is the wrong gate run with extra
  // confidence.
  test('an unknown field is an error with a suggestion', async () => {
    await expect(resolveConfig(writeConfig(`${VALID_FIELDS}\n  scann: [],`))).rejects.toThrow(
      "unknown field 'scann', did you mean 'scan'?",
    )
    await expect(resolveConfig(writeConfig(`${VALID_FIELDS}\n  banana: true,`))).rejects.toThrow(
      "unknown field 'banana'",
    )
  })

  test('a missing file is an error, not an empty config', async () => {
    await expect(
      resolveConfig(path.join(os.tmpdir(), 'definitely-absent', CONFIG_FILENAME)),
    ).rejects.toThrow('Cannot import')
  })
})

describe('finding the config', () => {
  test('walks up from a nested directory', () => {
    const configPath = writeConfig(VALID_FIELDS)
    const nested = path.join(path.dirname(configPath), 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })

    expect(findConfig(nested)).toBe(configPath)
  })

  // The tucked-away location. Supported so a project can keep its root clean,
  // but the CLI is typed at the project root, so discovery must reach down.
  test(`finds a config tucked into ${CONFIG_DIRECTORY}/`, () => {
    const configPath = writeConfig(VALID_FIELDS)
    const root = path.dirname(configPath)
    const nested = path.join(root, CONFIG_DIRECTORY)
    fs.mkdirSync(nested)
    fs.renameSync(configPath, path.join(nested, CONFIG_FILENAME))

    expect(findConfig(root)).toBe(path.join(nested, CONFIG_FILENAME))
  })

  test(`a config beside the caller wins over one in ${CONFIG_DIRECTORY}/`, () => {
    const configPath = writeConfig(VALID_FIELDS)
    const root = path.dirname(configPath)
    const nested = path.join(root, CONFIG_DIRECTORY)
    fs.mkdirSync(nested)
    fs.copyFileSync(configPath, path.join(nested, CONFIG_FILENAME))

    expect(findConfig(root)).toBe(configPath)
  })

  // The JSON form is gone: a leftover fitc4.config.json is not silently
  // honored OR silently skipped into an ancestor's config — it is simply not
  // a config name anymore, and the not-found error names what is.
  test('a fitc4.config.json is not a recognized config', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-json-'))
    created.push(directory)
    fs.writeFileSync(path.join(directory, 'fitc4.config.json'), '{}\n')

    expect(() => findConfig(directory)).toThrow(/No fitc4\.config\.ts/)
  })

  test('reports where it looked when there is none', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-noconfig-'))
    created.push(directory)

    // If this throws for "found one", an ancestor of the temp dir holds a
    // stray fitc4 config — an environment problem worth failing on, not
    // something to pass silently.
    expect(() => findConfig(directory)).toThrow(CONFIG_FILENAME)
    expect(() => findConfig(directory)).toThrow(directory)
    // And names the next step: a list of filenames leaves the most likely
    // reader, someone in a project fitc4 was never set up in, to guess.
    expect(() => findConfig(directory)).toThrow("Run 'npx fitc4 init' to scaffold one.")
  })
})
