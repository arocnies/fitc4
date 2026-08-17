/**
 * `soffit.config.json` — the project-specific inputs.
 *
 * This holds only what differs between repositories: where the code is, where
 * the model is, and which tsconfig describes module resolution. Providers are
 * still composed in code (POC-DESIGN-v4 defers command providers), so there is
 * no provider configuration here yet.
 *
 * Every path is resolved relative to the config file, so moving the workspace
 * does not silently repoint the scan.
 */

import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_FILENAME = 'soffit.config.json'
export const CONFIG_VERSION = 1

export interface SoffitConfig {
  /** Absolute repository root. Every reported path is relative to this. */
  repositoryRoot: string
  /** Absolute directory holding the LikeC4 workspace. */
  modelDir: string
  /** Repository-relative directories under architecture control. */
  scanRoots: string[]
  /** Absolute path to the tsconfig supplying compiler options. */
  tsconfigPath: string
}

/**
 * Read and validate the config.
 *
 * Validation is deliberately strict and hand-written. A malformed config that
 * quietly falls back to defaults would scan the wrong tree and report a clean
 * pass — the same fail-open the pipeline works hard to avoid everywhere else.
 */
export function loadConfig(configPath: string): SoffitConfig {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${messageOf(error)}`)
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath}: expected a JSON object`)
  }
  const record = raw as Record<string, unknown>

  if (record['version'] !== CONFIG_VERSION) {
    throw new Error(
      `${configPath}: unsupported version ${JSON.stringify(record['version'])}; expected ${CONFIG_VERSION}`,
    )
  }

  const base = path.dirname(path.resolve(configPath))
  const resolve = (key: string): string =>
    path.resolve(base, requireString(configPath, record, key))

  const scanRoots = requireStringArray(configPath, record, 'scanRoots')
  if (scanRoots.length === 0) {
    throw new Error(`${configPath}: scanRoots must list at least one directory`)
  }

  return {
    repositoryRoot: resolve('repositoryRoot'),
    modelDir: resolve('model'),
    scanRoots,
    tsconfigPath: resolve('tsconfig'),
  }
}

/**
 * An optional directory to tuck the config into.
 *
 * The config belongs at the project root, beside `tsconfig.json` — that is
 * where every other tool in this ecosystem keeps one, and where a reader looks.
 * This exists only for projects that would rather not add another root-level
 * file. It deliberately does not hold the model: `model.c4` is authored
 * architecture documentation with value independent of this tool, so it lives
 * wherever the `model` setting points and stays visible.
 */
export const CONFIG_DIRECTORY = '.soffit'

/**
 * Find `soffit.config.json`, starting at a directory and walking up.
 *
 * At each level the root-level file wins over the one in `.soffit/`, so a
 * project that hoists its config is never silently overruled by the copy it
 * left behind.
 */
export function findConfig(from: string): string {
  let directory = path.resolve(from)

  for (;;) {
    for (const candidate of [
      path.join(directory, CONFIG_FILENAME),
      path.join(directory, CONFIG_DIRECTORY, CONFIG_FILENAME),
    ]) {
      if (fs.existsSync(candidate)) return candidate
    }

    const parent = path.dirname(directory)
    if (parent === directory) {
      throw new Error(
        `No ${CONFIG_FILENAME} found in ${path.resolve(from)}, ` +
          `its ${CONFIG_DIRECTORY}/ directory, or any ancestor.`,
      )
    }
    directory = parent
  }
}

function requireString(configPath: string, record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${configPath}: '${key}' must be a non-empty string`)
  }
  return value
}

function requireStringArray(
  configPath: string,
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${configPath}: '${key}' must be an array of strings`)
  }
  return value as string[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
