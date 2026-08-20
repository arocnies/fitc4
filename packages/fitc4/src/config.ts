/**
 * `fitc4.config.{ts,js,json}`: the project-specific inputs.
 *
 * The JSON form holds only what differs between repositories: where the code
 * is, where the model is, and which tsconfig describes module resolution. The
 * module forms carry the same fields plus optional provider phase arrays,
 * which cannot live in JSON because a provider is a function.
 *
 * Every path is resolved relative to the config file, so moving the workspace
 * does not silently repoint the scan.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { messageOf } from './errors.ts'
import type { NamedProvider, ResolveProvider, ScanProvider, ValidateProvider } from './types.ts'

export const CONFIG_FILENAME = 'fitc4.config.json'
export const CONFIG_VERSION = 1

/**
 * The recognized config filenames, in discovery order.
 *
 * Order matters only for the error message: two of these in one directory is
 * an error, never a precedence rule. A config that loses a silent tiebreak is
 * a config that is silently ignored, the same fail-open as a config that
 * quietly falls back to defaults.
 *
 * The `.mts`/`.mjs` forms exist for CommonJS packages: a `.ts`/`.js` config
 * loads as an ES module, which a `"type": "module"`-less project cannot
 * satisfy in-band any other way. Node's own error for that case tells
 * the author to use exactly these extensions.
 */
export const CONFIG_FILENAMES = [
  'fitc4.config.ts',
  'fitc4.config.mts',
  'fitc4.config.js',
  'fitc4.config.mjs',
  CONFIG_FILENAME,
] as const

const MODULE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs']

export interface FitC4Config {
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
 * What a `fitc4.config.ts` / `.js` module's default export must be.
 *
 * The same fields as the JSON config, plus optional provider phase arrays. A
 * phase array that is present replaces the defaults for that phase entirely.
 * See `pipelineConfig`. A config that extends a phase therefore names every
 * provider it wants, default entries included.
 */
export interface FitC4FileConfig {
  /** Config format version. Always `1`; an unknown version is an error, not a silent default. */
  version: typeof CONFIG_VERSION
  /** Repository root, relative to the config file. */
  repositoryRoot: string
  /** Directory holding the LikeC4 workspace, relative to the config file. */
  model: string
  /** Repository-relative directories under architecture control. */
  scanRoots: string[]
  /** Path to the tsconfig supplying compiler options, relative to the config file. */
  tsconfig: string
  /**
   * Replaces the default scan phase entirely. The default scanner is built
   * from `tsconfig` and `scanRoots`. Rebuild it with
   * `typescriptImports({ tsconfigPath, roots })` if you still want import
   * scanning alongside your own provider.
   */
  scan?: NamedProvider<ScanProvider>[]
  /** Replaces the default resolve phase; spread `defaultResolve` to keep it. */
  resolve?: NamedProvider<ResolveProvider>[]
  /** Replaces the default validate phase; spread `defaultValidate` to keep the standard rules. */
  validate?: NamedProvider<ValidateProvider>[]
}

/** A loaded config plus whichever provider phases the config file supplied. */
export interface ResolvedConfig extends FitC4Config {
  providers?: {
    scan?: NamedProvider<ScanProvider>[]
    resolve?: NamedProvider<ResolveProvider>[]
    validate?: NamedProvider<ValidateProvider>[]
  }
}

/**
 * Identity, for the config author's editor.
 *
 * A default export annotated by hand drifts silently when the shape changes;
 * wrapping it in `defineConfig` makes a stale config a type error in the
 * project that owns it, before this package ever loads it.
 */
export function defineConfig(config: FitC4FileConfig): FitC4FileConfig {
  return config
}

/**
 * Read and validate a JSON config.
 *
 * The synchronous, JSON-only loader: importing a module config is inherently
 * async, so this is the form library callers can use inside synchronous
 * setup. The CLI goes through `resolveConfig`, which handles every form.
 */
export function loadConfig(configPath: string): FitC4Config {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${messageOf(error)}`)
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath}: expected a JSON object`)
  }

  return validateFields(configPath, raw as Record<string, unknown>, 'json')
}

/**
 * Load any of the three config forms.
 *
 * A `.json` path behaves exactly like `loadConfig`. A `.ts` or `.js` path is
 * imported and its default export validated with the same strictness. The
 * module form does not get a laxer contract just because a compiler already
 * saw it, since nothing forces a config author to typecheck the file. Node
 * strips types natively at this package's engines floor, so importing a `.ts`
 * config needs no loader.
 */
export async function resolveConfig(configPath: string): Promise<ResolvedConfig> {
  const resolved = path.resolve(configPath)
  if (!MODULE_EXTENSIONS.some((extension) => resolved.endsWith(extension))) {
    return loadConfig(resolved)
  }

  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Cannot import ${configPath}: ${messageOf(error)}`)
  }

  const raw = module['default']
  if (raw === undefined) {
    throw new Error(`${configPath}: the config must be the module's default export`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${configPath}: the default export must be a config object`)
  }
  const record = raw as Record<string, unknown>

  const config: ResolvedConfig = validateFields(configPath, record, 'module')
  const scan = requireProviders<ScanProvider>(configPath, record, 'scan')
  const resolve = requireProviders<ResolveProvider>(configPath, record, 'resolve')
  const validate = requireProviders<ValidateProvider>(configPath, record, 'validate')
  if (scan !== undefined || resolve !== undefined || validate !== undefined) {
    config.providers = { scan, resolve, validate }
  }
  return config
}

/** The fields every config form carries. `$schema` is the JSON editor hook. */
const SHARED_KEYS = ['version', 'repositoryRoot', 'model', 'scanRoots', 'tsconfig', '$schema']

/** The provider arrays, legal only where a function can live. */
const MODULE_KEYS = ['scan', 'resolve', 'validate']

/**
 * The validation shared by every config form.
 *
 * Deliberately strict and hand-written. A malformed config that quietly falls
 * back to defaults would scan the wrong tree and report a clean pass, the
 * same fail-open the pipeline works hard to avoid everywhere else. Unknown
 * keys are rejected for the same reason: a typo'd `scanRoot` that is silently
 * ignored is a scan of the wrong tree with extra confidence.
 */
function validateFields(
  configPath: string,
  record: Record<string, unknown>,
  form: 'json' | 'module',
): FitC4Config {
  rejectUnknownKeys(configPath, record, form)

  if (record['version'] === undefined) {
    throw new Error(`${configPath}: missing required field 'version' (add "version": ${CONFIG_VERSION})`)
  }
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

function rejectUnknownKeys(
  configPath: string,
  record: Record<string, unknown>,
  form: 'json' | 'module',
): void {
  const known = form === 'module' ? [...SHARED_KEYS, ...MODULE_KEYS] : SHARED_KEYS

  for (const key of Object.keys(record)) {
    if (known.includes(key)) continue
    if (form === 'json' && MODULE_KEYS.includes(key)) {
      throw new Error(
        `${configPath}: '${key}' is only available in the module config forms ` +
          `(.ts/.mts/.js/.mjs) — a provider is a function, which JSON cannot carry`,
      )
    }
    const candidates = known.filter((name) => name !== '$schema')
    const suggestion = closestName(key, candidates)
    throw new Error(
      `${configPath}: unknown field '${key}'` +
        (suggestion === undefined ? '' : ` — did you mean '${suggestion}'?`),
    )
  }
}

/** The known name within edit distance 2, if any. Enough for the typo case. */
export function closestName(key: string, candidates: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined
  for (const name of candidates) {
    const distance = editDistance(key.toLowerCase(), name.toLowerCase())
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name, distance }
    }
  }
  return best?.name
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0
      row[j] = Math.min(
        current + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] ?? 0
}

/**
 * An optional directory to tuck the config into.
 *
 * The config belongs at the project root, beside `tsconfig.json`. That is
 * where every other tool in this ecosystem keeps one, and where a reader looks.
 * This exists only for projects that would rather not add another root-level
 * file. It deliberately does not hold the model: `model.c4` is authored
 * architecture documentation with value independent of this tool, so it lives
 * wherever the `model` setting points and stays visible.
 */
export const CONFIG_DIRECTORY = '.fitc4'

/**
 * Find a fitc4 config, starting at a directory and walking up.
 *
 * At each level the root-level file wins over the one in `.fitc4/`, so a
 * project that hoists its config is never silently overruled by the copy it
 * left behind. Within one directory there is no such precedence: two config
 * files there is an error, because whichever lost a tiebreak would be
 * silently ignored, and an ignored config is a fail-open.
 */
export function findConfig(from: string): string {
  let directory = path.resolve(from)

  for (;;) {
    for (const location of [directory, path.join(directory, CONFIG_DIRECTORY)]) {
      const found = CONFIG_FILENAMES.map((name) => path.join(location, name)).filter((candidate) =>
        fs.existsSync(candidate),
      )
      if (found.length > 1) {
        throw new Error(
          `Multiple configs in one directory: ${found.join(' and ')}. ` +
            `All but one would be silently ignored, so keep exactly one.`,
        )
      }
      if (found[0] !== undefined) return found[0]
    }

    const parent = path.dirname(directory)
    if (parent === directory) {
      throw new Error(
        `No ${CONFIG_FILENAMES.join(', ')} found in ${path.resolve(from)}, ` +
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

/**
 * Validate one provider phase array structurally.
 *
 * Structural, not behavioral: `run` is checked to be a function, nothing
 * more. What it must return is the pipeline's contract, and the pipeline
 * already contains a misbehaving provider as an error finding. What cannot be
 * deferred is the shape. An entry with no `run` would only show up once the
 * pipeline tried to call it, blamed on the wrong layer.
 */
function requireProviders<T>(
  configPath: string,
  record: Record<string, unknown>,
  key: string,
): NamedProvider<T>[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`${configPath}: '${key}' must be an array of providers`)
  }

  value.forEach((entry, index) => {
    const candidate =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : undefined
    const id = candidate?.['id']
    const run = candidate?.['run']
    if (candidate === undefined || typeof id !== 'string' || id.trim() === '' || typeof run !== 'function') {
      throw new Error(
        `${configPath}: '${key}[${index}]' must be a provider with a string 'id' and a function 'run'`,
      )
    }
  })

  return value as NamedProvider<T>[]
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
  // A blank entry is not a harmless no-op: as a path prefix it matches
  // everything, silently putting the whole repository under scan.
  const blank = value.findIndex((entry) => (entry as string).trim() === '')
  if (blank !== -1) {
    throw new Error(
      `${configPath}: '${key}[${blank}]' must be a non-empty string — ` +
        `an empty entry would put the entire repository under scan`,
    )
  }
  return value as string[]
}
