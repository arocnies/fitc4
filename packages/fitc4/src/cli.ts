#!/usr/bin/env node
/**
 * The `fitc4` command line entry point.
 *
 * This module runs the pipeline on import, so nothing else in the package may
 * import it. The provider composition lives in `defaults.ts` for that reason.
 */

import fs from 'node:fs'
import path from 'node:path'
import { closestName, findConfig, resolveConfig } from './config.ts'
import { messageOf } from './errors.ts'
import { init } from './init.ts'
import { runPipeline } from './pipeline.ts'
import { pipelineConfig } from './defaults.ts'
import { exitCodeFor, renderReport } from './report.ts'

const USAGE = `Usage: fitc4 [command] [options]

Commands:
  (none)           Check the code against the LikeC4 architecture model.
  init             Scaffold fitc4.config.json, a starter arch/model.c4, and
                   an AGENTS.md with the fitc4 norms in the current
                   directory. Never overwrites existing files.

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

interface Arguments {
  help: boolean
  version: boolean
  command: 'init' | undefined
  configPath: string | undefined
  json: boolean
}

const KNOWN_OPTIONS = ['--help', '--version', '--config', '--json']
const KNOWN_COMMANDS = ['init']

/**
 * Parse argv, rejecting anything unrecognized.
 *
 * A typo'd flag or command that is silently ignored runs the default check
 * instead of what was asked — `--josn` quietly loses the JSON output some
 * script was about to parse. Same fail-open as an ignored config key, so it
 * gets the same treatment: a loud error with a suggestion when one is close.
 */
function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    help: false,
    version: false,
    command: undefined,
    configPath: undefined,
    json: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string

    if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else if (argument === '--version') {
      parsed.version = true
    } else if (argument === '--json') {
      parsed.json = true
    } else if (argument === '--config') {
      index += 1
      const value = argv[index]
      // Silently discovering a different config than the one named would
      // check the wrong repository and report it as this one.
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--config requires a path')
      }
      parsed.configPath = path.resolve(value)
    } else if (argument.startsWith('-')) {
      throw new Error(unknownArgument('option', argument, KNOWN_OPTIONS))
    } else if (parsed.command === undefined && KNOWN_COMMANDS.includes(argument)) {
      parsed.command = argument as 'init'
    } else {
      throw new Error(unknownArgument('command', argument, KNOWN_COMMANDS))
    }
  }

  return parsed
}

function unknownArgument(what: string, argument: string, known: string[]): string {
  const suggestion = closestName(argument, known)
  return (
    `unknown ${what} '${argument}'` +
    (suggestion === undefined ? '' : ` — did you mean '${suggestion}'?`)
  )
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
  const options = parseArguments(process.argv.slice(2))

  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (options.version) {
    process.stdout.write(`${version()}\n`)
    return
  }
  if (options.command === 'init') {
    runInit()
    return
  }

  // Config discovery starts at the working directory, never at this file.
  // Deriving it from `import.meta.url` works only while the tool lives in the
  // repository it checks. Installed from a package it would resolve inside
  // `node_modules` and find the wrong config, or none.
  const configPath = options.configPath ?? findConfig(process.cwd())
  const result = await runPipeline(pipelineConfig(await resolveConfig(configPath)))

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
  process.stderr.write(`fitc4: ${messageOf(error)}\n`)
  process.exitCode = 1
}
