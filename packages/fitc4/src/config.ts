/**
 * `fitc4.config.{ts,mts,js,mjs}`: the project-specific inputs.
 *
 * One config form: a module whose default export names everything the
 * pipeline runs. The phases are explicit, never defaulted. A phase that is
 * not in the file does not run, so reading the config is reading the gate:
 * there is no hidden composition to know about, and no merge semantics.
 * Providers are functions, which is also why there is no JSON form.
 *
 * Every path is resolved relative to the config file, so moving the workspace
 * does not silently repoint the scan.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { closestName, messageOf } from './errors.ts'
import type { PipelineConfig } from './pipeline.ts'
import type {
  NamedProvider,
  ResolveProvider,
  ScanProvider,
  ValidateProvider,
} from './types.ts'

// Type-only on purpose: the core package never runtime-imports `fitc4/agent`
// (see the layering note in agent/index.ts), and an erased import keeps it
// that way while the config field still typechecks against the real contract.
import type { AgentExec } from './agent/exec.ts'

export const CONFIG_VERSION = 1

/**
 * The filename `init` scaffolds. `.mts` on purpose: it loads as an ES module
 * in ESM and CommonJS packages alike.
 */
export const CONFIG_FILENAME = 'fitc4.config.mts'

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
  CONFIG_FILENAME,
  'fitc4.config.js',
  'fitc4.config.mjs',
] as const

/**
 * What a fitc4 config module's default export must be.
 *
 * The three phase arrays are required and explicit. What runs is what the
 * file says runs: `typescriptImports(...)` under `scan`, `sourceRoot()` under
 * `resolve`, `architectureRules()` under `validate` is the standard gate, and
 * a config that wants more names more. There are no defaults to remember, no
 * spread idiom to keep the standard rules, and nothing composed in behind the
 * file's back.
 */
export interface FitC4FileConfig {
  /** Config format version. Always `1`; an unknown version is an error, not a silent default. */
  version: typeof CONFIG_VERSION
  /** Repository root, relative to the config file. */
  repositoryRoot: string
  /** Directory holding the LikeC4 workspace, relative to the config file. */
  model: string
  /** Base URL of a published LikeC4 viewer; findings link into it when set. */
  viewerBaseUrl?: string
  /** The scan phase: what observes the code. */
  scan: NamedProvider<ScanProvider>[]
  /** The resolve phase: what maps observations onto model elements. */
  resolve: NamedProvider<ResolveProvider>[]
  /** The validate phase: what judges the associations. This is the gate. */
  validate: NamedProvider<ValidateProvider>[]
  /**
   * The agent exec commands like `draft --describe` run on: an `AgentExec`
   * from `fitc4/agent` (`cached(claudeCli({ ... }))` and friends). Optional:
   * declaring it costs nothing, since no call happens until a command asks
   * for one. One place carries the model choice and billing surface, and the
   * CLI can say precisely what is missing when a command needs an exec and
   * the config has none.
   */
  agent?: AgentExec
}

/**
 * A loaded config, paths resolved absolute. Structurally a `PipelineConfig`,
 * so `runPipeline(config)` runs it as loaded.
 */
export interface ResolvedConfig extends PipelineConfig {
  /** The config file's `agent` exec, when it declared one. */
  agent?: AgentExec
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
 * Import a config module and validate its default export.
 *
 * Validated with full strictness even though a compiler may have seen the
 * file, since nothing forces a config author to typecheck it. Node strips
 * types natively at this package's engines floor, so importing a `.ts`
 * config needs no loader.
 */
export async function resolveConfig(configPath: string): Promise<ResolvedConfig> {
  const resolved = path.resolve(configPath)

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

  const config = validateFields(configPath, record)
  const agent = requireAgent(configPath, record)
  if (agent !== undefined) config.agent = agent
  return config
}

/** The fields a config module may carry. */
const KNOWN_KEYS = [
  'version',
  'repositoryRoot',
  'model',
  'viewerBaseUrl',
  'scan',
  'resolve',
  'validate',
  'agent',
]

/** What each missing phase's error suggests, ready to paste. */
const STANDARD_PHASES: Record<string, string> = {
  scan: `scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })]`,
  resolve: `resolve: [sourceRoot()]`,
  validate: `validate: [architectureRules()]`,
}

/**
 * The config validation.
 *
 * Deliberately strict and hand-written. A malformed config that quietly fell
 * back to anything would scan the wrong tree and report a clean pass, the
 * same fail-open the pipeline works hard to avoid everywhere else. Unknown
 * keys are rejected for the same reason: a typo'd `scann` that is silently
 * ignored is a gate with no scanner and extra confidence.
 */
function validateFields(configPath: string, record: Record<string, unknown>): ResolvedConfig {
  rejectUnknownKeys(configPath, record)

  if (record['version'] === undefined) {
    throw new Error(`${configPath}: missing required field 'version' (add version: ${CONFIG_VERSION})`)
  }
  if (record['version'] !== CONFIG_VERSION) {
    throw new Error(
      `${configPath}: unsupported version ${JSON.stringify(record['version'])}; expected ${CONFIG_VERSION}`,
    )
  }

  const base = path.dirname(path.resolve(configPath))
  const resolve = (key: string): string =>
    path.resolve(base, requireString(configPath, record, key))

  const viewerBaseUrl = optionalViewerBaseUrl(configPath, record)

  return {
    repositoryRoot: resolve('repositoryRoot'),
    modelDir: resolve('model'),
    ...(viewerBaseUrl === undefined ? {} : { viewerBaseUrl }),
    scan: requirePhase<ScanProvider>(configPath, record, 'scan'),
    resolve: requirePhase<ResolveProvider>(configPath, record, 'resolve'),
    validate: requirePhase<ValidateProvider>(configPath, record, 'validate'),
  }
}

/**
 * Validate the optional viewer base URL.
 *
 * Absolute http(s) only. A relative path or a bare hostname cannot be pasted
 * from an issue into a browser, so accepting one would mint links that work
 * for nobody. Deliberately not resolved relative to the config file: this
 * names a published site, not a file.
 */
function optionalViewerBaseUrl(
  configPath: string,
  record: Record<string, unknown>,
): string | undefined {
  const value = record['viewerBaseUrl']
  if (value === undefined) return undefined

  const complain = (): never => {
    throw new Error(
      `${configPath}: 'viewerBaseUrl' must be an absolute http(s) URL ` +
        `such as https://acme.github.io/arch/ (end it with #/ for a --use-hash-history build)`,
    )
  }

  if (typeof value !== 'string' || value.trim() === '') return complain()
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return complain()
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return complain()
  return trimmed
}

function rejectUnknownKeys(configPath: string, record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (KNOWN_KEYS.includes(key)) continue
    const suggestion = closestName(key, KNOWN_KEYS)
    throw new Error(
      `${configPath}: unknown field '${key}'` +
        (suggestion === undefined ? '' : `, did you mean '${suggestion}'?`),
    )
  }
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
      // Names the next step, not only the dead end: the most likely reader of
      // this message is someone running fitc4 in a project it was never set
      // up in, and listing filenames leaves them to guess which to write.
      throw new Error(
        `No ${CONFIG_FILENAMES.join(', ')} found in ${path.resolve(from)}, ` +
          `its ${CONFIG_DIRECTORY}/ directory, or any ancestor. ` +
          `Run 'npx fitc4 init' to scaffold one.`,
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
 * Validate one required provider phase, structurally.
 *
 * Required, because the phases are the gate and an absent one runs nothing.
 * The missing-phase error carries the standard composition ready to paste,
 * so "explicit" never means "go find out what the default would have been".
 * An empty array is rejected for the same reason it would be suspicious in a
 * report: a validate phase with no providers passes everything, silently.
 *
 * Structural, not behavioral: `run` is checked to be a function, nothing
 * more. What it must return is the pipeline's contract, and the pipeline
 * already contains a misbehaving provider as an error finding. What cannot be
 * deferred is the shape. An entry with no `run` would only show up once the
 * pipeline tried to call it, blamed on the wrong layer.
 */
function requirePhase<T>(
  configPath: string,
  record: Record<string, unknown>,
  key: 'scan' | 'resolve' | 'validate',
): NamedProvider<T>[] {
  const value = record[key]
  if (value === undefined) {
    throw new Error(
      `${configPath}: missing '${key}'. Phases are explicit; the standard one is ` +
        `${STANDARD_PHASES[key]} (imported from 'fitc4')`,
    )
  }
  if (!Array.isArray(value)) {
    throw new Error(`${configPath}: '${key}' must be an array of providers`)
  }
  if (value.length === 0) {
    throw new Error(
      `${configPath}: '${key}' lists no providers, so nothing would run in that phase. ` +
        `The standard one is ${STANDARD_PHASES[key]} (imported from 'fitc4')`,
    )
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

/**
 * Validate the optional `agent` exec structurally, mirroring the provider
 * checks: a non-empty string `id` and a function `run`, nothing behavioral.
 * A malformed exec caught here is blamed on the config that declared it. Left
 * to surface later, it would fail inside whatever command first calls it,
 * blamed on the wrong layer.
 */
function requireAgent(configPath: string, record: Record<string, unknown>): AgentExec | undefined {
  const value = record['agent']
  if (value === undefined) return undefined

  const candidate =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  const id = candidate?.['id']
  const run = candidate?.['run']
  if (candidate === undefined || typeof id !== 'string' || id.trim() === '' || typeof run !== 'function') {
    throw new Error(
      `${configPath}: 'agent' must be an agent exec with a string 'id' and a function 'run', ` +
        `such as cached(claudeCli({ model: 'sonnet' })) from 'fitc4/agent'`,
    )
  }
  return value as AgentExec
}
