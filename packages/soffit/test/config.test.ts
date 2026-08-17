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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soffit-config-'))
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
    ['a missing version', { ...VALID, version: undefined }, 'unsupported version'],
    ['a future version', { ...VALID, version: 2 }, 'unsupported version'],
    ['an empty scanRoots', { ...VALID, scanRoots: [] }, 'at least one directory'],
    ['a non-array scanRoots', { ...VALID, scanRoots: 'src' }, 'array of strings'],
    ['a non-string entry', { ...VALID, scanRoots: ['src', 3] }, 'array of strings'],
    ['a blank path', { ...VALID, model: '  ' }, "'model' must be a non-empty string"],
    ['a missing tsconfig', { ...VALID, tsconfig: undefined }, "'tsconfig' must be"],
  ])('%s is an error', (_label, contents, expected) => {
    expect(() => loadConfig(writeConfig(contents))).toThrow(expected)
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
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soffit-noconfig-'))
    created.push(directory)

    // Only meaningful if no ancestor of the temp dir happens to hold one.
    try {
      findConfig(directory)
    } catch (error) {
      expect((error as Error).message).toContain(CONFIG_FILENAME)
    }
  })
})
