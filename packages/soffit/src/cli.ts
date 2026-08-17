#!/usr/bin/env node
/**
 * The `soffit` command line entry point.
 *
 * This module runs the pipeline on import, so nothing else in the package may
 * import it. The provider composition lives in `preset.ts` for that reason.
 */

import fs from 'node:fs'
import path from 'node:path'
import { findConfig, resolveConfig } from './config.ts'
import { runPipeline } from './pipeline.ts'
import { pipelineConfig } from './preset.ts'
import { exitCodeFor, renderReport } from './report.ts'

const USAGE = `Usage: soffit [options]

  --config <path>  Path to a soffit config (.ts, .js, or .json). Defaults to
                   discovery from the working directory: soffit.config.ts,
                   soffit.config.js, or soffit.config.json in ./, then in
                   ./.soffit/, then the same in each ancestor. Two of the
                   three in one directory is an error.
  --json           Emit the full result as JSON instead of a report.
  --version        Print the version.
  --help           Show this message.

Exits non-zero when any finding has severity 'error'.`

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--version')) {
    process.stdout.write(`${version()}\n`)
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

await main()
