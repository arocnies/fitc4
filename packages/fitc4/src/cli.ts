#!/usr/bin/env node
/**
 * The `fitc4` command line entry point.
 *
 * This module runs the pipeline on import, so nothing else in the package may
 * import it. The provider composition lives in `defaults.ts` for that reason.
 */

import fs from 'node:fs'
import path from 'node:path'
import { findConfig, resolveConfig } from './config.ts'
import { init } from './init.ts'
import { runPipeline } from './pipeline.ts'
import { pipelineConfig } from './defaults.ts'
import { exitCodeFor, renderReport } from './report.ts'

const USAGE = `Usage: fitc4 [command] [options]

Commands:
  (none)           Check the code against the LikeC4 architecture model.
  init             Scaffold fitc4.config.json and a starter arch/model.c4 in
                   the current directory. Never overwrites existing files.

Options:
  --config <path>  Path to a fitc4 config (.ts, .mts, .js, .mjs, or .json).
                   Defaults to discovery from the working directory: each of
                   those names in ./, then in ./.fitc4/, then the same in
                   each ancestor. Two configs in one directory is an error.
  --json           Emit the full result as JSON instead of a report.
  --version        Print the version.
  --help           Show this message.

A .ts/.js config loads as an ES module; in a CommonJS package name it
fitc4.config.mts or set "type": "module". Exits non-zero when any finding
has severity 'error'.`

/**
 * Read the version from this package's own manifest.
 *
 * `../package.json` is correct from both `src/` and `dist/`, which is the
 * point — a hardcoded string would drift from the manifest on the first
 * release that forgets to update it.
 */
function version(): string {
  const manifest = new URL('../package.json', import.meta.url)
  const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    return String((parsed as { version: unknown }).version)
  }
  return 'unknown'
}

interface Options {
  configPath: string
  json: boolean
}

/**
 * Config discovery starts at the working directory, never at this file.
 *
 * Deriving it from `import.meta.url` works only while the tool lives in the
 * repository it checks. Installed from a package it would resolve inside
 * `node_modules` and find the wrong config, or none.
 */
function parseArguments(argv: string[]): Options | undefined {
  if (argv.includes('--help') || argv.includes('-h')) return undefined

  const flag = argv.indexOf('--config')
  if (flag !== -1) {
    const value = argv[flag + 1]
    // Silently discovering a different config than the one named would check
    // the wrong repository and report it as this one.
    if (value === undefined || value.startsWith('-')) {
      throw new Error('--config requires a path')
    }
    return { configPath: path.resolve(value), json: argv.includes('--json') }
  }

  return { configPath: findConfig(process.cwd()), json: argv.includes('--json') }
}

function runInit(): void {
  const result = init(process.cwd())
  const lines = [
    ...result.created.map((file) => `created ${file}`),
    ...result.skipped.map((file) => `kept ${file} (already exists)`),
    ...result.notes.map((note) => `note: ${note}`),
    '',
    `Next: put your elements in arch/model.c4 — 'sources' says what each owns,`,
    `'->' declares a permitted dependency — then run: npx fitc4`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--version')) {
    process.stdout.write(`${version()}\n`)
    return
  }

  if (argv[0] === 'init') {
    runInit()
    return
  }

  const options = parseArguments(argv)
  if (options === undefined) {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  const result = await runPipeline(pipelineConfig(await resolveConfig(options.configPath)))

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = exitCodeFor(result)
    return
  }

  const report = renderReport(result)
  process.stdout.write(`${report.text}\n`)
  process.exitCode = report.exitCode
}

// A config mistake is the author's error to fix, not this tool's crash: the
// message is the whole story, and a stack trace through validateFields reads
// as a fitc4 bug while burying it.
try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`fitc4: ${message}\n`)
  process.exitCode = 1
}
