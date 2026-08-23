import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { CONFIG_DIRECTORY, CONFIG_FILENAME, findConfig, loadConfig } from '../src/config.ts'

const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function writeConfig(contents: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-config-'))
  created.push(directory)
  const configPath = path.join(directory, CONFIG_FILENAME)
  fs.writeFileSync(
    configPath,
    typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
  )
  return configPath
}

const VALID = {
  version: 1,
  repositoryRoot: '..',
  model: '.',
  scanRoots: ['src'],
  tsconfig: '../tsconfig.json',
}

describe('loading the config', () => {
  // The viewer base names a published site, so it must not be path-resolved,
  // and its absence is the feature being off, not a default.
  // Severity is the one piece of rule tuning a team reaches for while
  // adopting, so it is legal in JSON: it carries only strings, and putting it
  // behind a module config meant converting the file to change one word.
  test('accepts a severity map in the JSON form and leaves it absent otherwise', () => {
    expect(loadConfig(writeConfig(VALID)).severity).toBeUndefined()

    const promoted = { ...VALID, severity: { 'unmapped-source': 'error' } }
    expect(loadConfig(writeConfig(promoted)).severity).toEqual({ 'unmapped-source': 'error' })

    const both = { ...VALID, severity: { 'unused-drift': 'error', 'unresolved-import': 'info' } }
    expect(loadConfig(writeConfig(both)).severity).toEqual({
      'unused-drift': 'error',
      'unresolved-import': 'info',
    })
  })

  // An ignored key here is a team believing their gate is closed when it is
  // open, which is exactly the fail-open this module exists to prevent.
  test('rejects an unknown rule id, suggesting the near miss', () => {
    expect(() =>
      loadConfig(writeConfig({ ...VALID, severity: { 'unmaped-source': 'error' } })),
    ).toThrow(/unknown rule 'unmaped-source', did you mean 'unmapped-source'\?/)
    expect(() =>
      loadConfig(writeConfig({ ...VALID, severity: { 'totally-made-up': 'error' } })),
    ).toThrow(/unknown rule 'totally-made-up'/)
    // No suggestion when nothing is close, rather than a misleading one.
    expect(() =>
      loadConfig(writeConfig({ ...VALID, severity: { 'totally-made-up': 'error' } })),
    ).not.toThrow(/did you mean/)
  })

  test.each([
    ['an unknown level', { 'unmapped-source': 'fatal' }],
    ['a non-string level', { 'unmapped-source': 2 }],
    ['a null level', { 'unmapped-source': null }],
  ])('rejects %s', (_label, severity) => {
    expect(() => loadConfig(writeConfig({ ...VALID, severity }))).toThrow(
      /must be one of error, warning, info/,
    )
  })

  test.each([
    ['a bare string', 'error'],
    ['an array', ['error']],
    ['null', null],
  ])('rejects severity as %s', (_label, severity) => {
    expect(() => loadConfig(writeConfig({ ...VALID, severity }))).toThrow(
      /'severity' must be an object mapping rule ids/,
    )
  })

  test('keeps viewerBaseUrl verbatim and optional', () => {
    expect(loadConfig(writeConfig(VALID)).viewerBaseUrl).toBeUndefined()

    const base = 'https://acme.github.io/arch/#/'
    expect(loadConfig(writeConfig({ ...VALID, viewerBaseUrl: base })).viewerBaseUrl).toBe(base)
  })

  test.each([
    ['a non-string', 7],
    ['a blank string', '  '],
    ['a relative path', './site'],
    ['a schemeless host', 'acme.github.io/arch'],
    ['a non-http scheme', 'ftp://acme.github.io/arch'],
  ])('rejects %s viewerBaseUrl', (_label, value) => {
    expect(() => loadConfig(writeConfig({ ...VALID, viewerBaseUrl: value }))).toThrow(
      "'viewerBaseUrl' must be an absolute http(s) URL",
    )
  })

  test('resolves every path relative to the config file', () => {
    const configPath = writeConfig(VALID)
    const base = path.dirname(configPath)
    const config = loadConfig(configPath)

    expect(config.repositoryRoot).toBe(path.resolve(base, '..'))
    expect(config.modelDir).toBe(path.resolve(base, '.'))
    expect(config.tsconfigPath).toBe(path.resolve(base, '../tsconfig.json'))
    expect(config.scanRoots).toEqual(['src'])
  })

  // The shipped example is the only config authored the way a consumer would
  // author one. If its paths stop resolving, the documented layout is wrong.
  test("the example project's config loads and points at the example", () => {
    const example = path.resolve(import.meta.dirname, '../../../example')
    const configPath = findConfig(example)

    expect(configPath).toBe(path.join(example, CONFIG_FILENAME))

    const config = loadConfig(configPath)
    expect(config.repositoryRoot).toBe(example)
    expect(config.scanRoots).toEqual(['src'])
    expect(fs.existsSync(config.tsconfigPath)).toBe(true)
    expect(fs.existsSync(path.join(config.modelDir, 'model.c4'))).toBe(true)
  })
})

// A config that quietly falls back to defaults would scan the wrong tree and
// report a clean pass — the same fail-open the pipeline avoids everywhere else.
describe('rejecting a malformed config', () => {
  test.each([
    ['a missing version', { ...VALID, version: undefined }, "missing required field 'version'"],
    ['a future version', { ...VALID, version: 2 }, 'unsupported version'],
    ['an empty scanRoots', { ...VALID, scanRoots: [] }, 'at least one directory'],
    ['a non-array scanRoots', { ...VALID, scanRoots: 'src' }, 'array of strings'],
    ['a non-string entry', { ...VALID, scanRoots: ['src', 3] }, 'array of strings'],
    // A blank scan root is not a harmless no-op: as a prefix it matches
    // everything, silently putting the whole repository under scan.
    ['a blank scanRoots entry', { ...VALID, scanRoots: ['src', ' '] }, "'scanRoots[1]'"],
    ['a blank path', { ...VALID, model: '  ' }, "'model' must be a non-empty string"],
    ['a missing tsconfig', { ...VALID, tsconfig: undefined }, "'tsconfig' must be"],
  ])('%s is an error', (_label, contents, expected) => {
    expect(() => loadConfig(writeConfig(contents))).toThrow(expected)
  })

  // A typo'd key that is silently ignored is the wrong tree scanned with
  // extra confidence — the schema says additionalProperties: false, and the
  // runtime must not be laxer than the editor.
  test('an unknown field is an error with a suggestion', () => {
    expect(() => loadConfig(writeConfig({ ...VALID, scanRoot: ['src'] }))).toThrow(
      "unknown field 'scanRoot', did you mean 'scanRoots'?",
    )
    expect(() => loadConfig(writeConfig({ ...VALID, banana: true }))).toThrow(
      "unknown field 'banana'",
    )
  })

  test('provider arrays in JSON are named as a module-form feature', () => {
    expect(() => loadConfig(writeConfig({ ...VALID, validate: [] }))).toThrow(
      'only available in the module config forms (.ts/.mts/.js/.mjs)',
    )
  })

  // The same module-only boundary, worded for what 'agent' actually is: not a
  // provider array, but still a function JSON cannot carry.
  test('an agent field in JSON is named as a module-form feature', () => {
    expect(() => loadConfig(writeConfig({ ...VALID, agent: { id: 'x' } }))).toThrow(
      'only available in the module config forms (.ts/.mts/.js/.mjs). ' +
        'An agent exec is a function, which JSON cannot carry',
    )
  })

  test('malformed JSON names the file', () => {
    const configPath = writeConfig('{ not json')
    expect(() => loadConfig(configPath)).toThrow(configPath)
  })

  test('a JSON array is not a config', () => {
    expect(() => loadConfig(writeConfig([]))).toThrow('expected a JSON object')
  })

  test('a missing file is an error, not an empty config', () => {
    expect(() => loadConfig(path.join(os.tmpdir(), 'definitely-absent.json'))).toThrow('Cannot read')
  })
})

describe('finding the config', () => {
  test('walks up from a nested directory', () => {
    const configPath = writeConfig(VALID)
    const nested = path.join(path.dirname(configPath), 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })

    expect(findConfig(nested)).toBe(configPath)
  })

  // The tucked-away location. Supported so a project can keep its root clean,
  // but the CLI is typed at the project root, so discovery must reach down.
  test(`finds a config tucked into ${CONFIG_DIRECTORY}/`, () => {
    const configPath = writeConfig(VALID)
    const root = path.dirname(configPath)
    const nested = path.join(root, CONFIG_DIRECTORY)
    fs.mkdirSync(nested)
    fs.renameSync(configPath, path.join(nested, CONFIG_FILENAME))

    expect(findConfig(root)).toBe(path.join(nested, CONFIG_FILENAME))
  })

  test(`a config beside the caller wins over one in ${CONFIG_DIRECTORY}/`, () => {
    const configPath = writeConfig(VALID)
    const root = path.dirname(configPath)
    const nested = path.join(root, CONFIG_DIRECTORY)
    fs.mkdirSync(nested)
    fs.copyFileSync(configPath, path.join(nested, CONFIG_FILENAME))

    expect(findConfig(root)).toBe(configPath)
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
