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
import { draft, type DraftDescribe } from './draft.ts'
import { messageOf } from './errors.ts'
import { init, INIT_AGENTS, type InitAgent } from './init.ts'
import { runPipeline } from './pipeline.ts'
import { pipelineConfig } from './defaults.ts'
import { count, exitCodeFor, renderReport } from './report.ts'

const USAGE = `Usage: fitc4 [command] [options]

Commands:
  (none)           Check the code against the LikeC4 architecture model.
  init             Scaffold fitc4.config.json, a starter arch/model.c4, and
                   an AGENTS.md with the fitc4 norms in the current
                   directory. Never overwrites existing files. With --agent,
                   scaffolds a fitc4.config.mts module config instead, wired
                   to that agent CLI and ready for draft --describe.
  draft            Run the configured scan providers and write a first-draft
                   model.c4 into the configured model directory. Elements
                   mirror the structure the observations report: a directory
                   splits into nested elements where observed dependencies
                   cross inside it and collapses where none do, observed
                   fragments become elements of their own, and one stub
                   element claims the observed external packages. Every
                   relationship is tagged as drift, so the first check is
                   green and the drift line counts the debt down; untagging
                   an edge blesses it. A draft to rewrite, never a sync.
                   Never overwrites: if any model file exists, the draft is
                   printed to stdout instead. With --describe, the config's
                   agent exec proposes each element's description.

Options:
  --config <path>  Path to a fitc4 config (.ts, .mts, .js, .mjs, or .json).
                   Defaults to discovery from the working directory: each of
                   those names in ./, then in ./.fitc4/, then the same in
                   each ancestor. Two configs in one directory is an error.
  --json           Emit the full result as JSON instead of a report.
  --agent <cli>    With init: scaffold a fitc4.config.mts wired to 'claude'
                   or 'codex'. The exec runs your own CLI on your own login
                   and billing.
  --no-drift       With draft: emit plain relationships instead of
                   drift-tagged ones.
  --describe       With draft: replace each eligible element's TODO
                   description with one or two sentences proposed by the
                   config's agent exec from the files the element owns. A
                   failed call keeps the TODO; the draft never fails over a
                   description.
  --quiet          Suppress the progress narration. Narration goes to stderr,
                   so the report and --json output are unaffected either way.
  --version        Print the version.
  --help           Show this message.

A .ts/.js config loads as an ES module; in a CommonJS package name it
fitc4.config.mts or set "type": "module". Exits non-zero when any finding
has severity 'error'.`

/**
 * Read the version from this package's own manifest.
 *
 * `../package.json` is correct from both `src/` and `dist/`, which is the
 * point. A hardcoded string would drift from the manifest on the first
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
  command: 'init' | 'draft' | undefined
  configPath: string | undefined
  json: boolean
  noDrift: boolean
  describe: boolean
  agent: InitAgent | undefined
  quiet: boolean
}

const KNOWN_OPTIONS = [
  '--help',
  '--version',
  '--config',
  '--json',
  '--agent',
  '--no-drift',
  '--describe',
  '--quiet',
]
const KNOWN_COMMANDS = ['init', 'draft']

/**
 * Parse argv, rejecting anything unrecognized.
 *
 * A typo'd flag or command that is silently ignored runs the default check
 * instead of what was asked. A typo'd `--josn` quietly loses the JSON output
 * some script was about to parse. Same fail-open as an ignored config key, so it
 * gets the same treatment: a loud error with a suggestion when one is close.
 */
function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    help: false,
    version: false,
    command: undefined,
    configPath: undefined,
    json: false,
    noDrift: false,
    describe: false,
    agent: undefined,
    quiet: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string

    if (argument === '--help' || argument === '-h') {
      parsed.help = true
    } else if (argument === '--version') {
      parsed.version = true
    } else if (argument === '--json') {
      parsed.json = true
    } else if (argument === '--no-drift') {
      parsed.noDrift = true
    } else if (argument === '--describe') {
      parsed.describe = true
    } else if (argument === '--agent') {
      index += 1
      const value = argv[index]
      // The value decides which CLI the scaffolded config bills against, so a
      // missing or unknown one is an error, never a silent default.
      if (value === undefined || !(INIT_AGENTS as readonly string[]).includes(value)) {
        throw new Error(
          `--agent requires one of: ${INIT_AGENTS.join(', ')}` +
            (value === undefined ? '' : `; got '${value}'`),
        )
      }
      parsed.agent = value as InitAgent
    } else if (argument === '--quiet') {
      parsed.quiet = true
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
      parsed.command = argument as 'init' | 'draft'
    } else {
      throw new Error(unknownArgument('command', argument, KNOWN_COMMANDS))
    }
  }

  // A silently ignored flag is the fail-open this parser exists to prevent:
  // `fitc4 --no-drift` would run the default check and look like a draft ran.
  if (parsed.noDrift && parsed.command !== 'draft') {
    throw new Error('--no-drift only applies to the draft command')
  }
  if (parsed.describe && parsed.command !== 'draft') {
    throw new Error('--describe only applies to the draft command')
  }
  if (parsed.agent !== undefined && parsed.command !== 'init') {
    throw new Error('--agent only applies to the init command')
  }

  return parsed
}

function unknownArgument(what: string, argument: string, known: string[]): string {
  const suggestion = closestName(argument, known)
  return (
    `unknown ${what} '${argument}'` +
    (suggestion === undefined ? '' : `, did you mean '${suggestion}'?`)
  )
}

function runInit(options: Arguments): void {
  const result = init(process.cwd(), options.agent === undefined ? {} : { agent: options.agent })
  const lines = [
    ...result.created.map((file) => `created ${file}`),
    ...result.skipped.map((file) => `kept ${file} (already exists)`),
    ...result.notes.map((note) => `note: ${note}`),
    '',
    `Next: put your elements in arch/model.c4. 'sources' says what each owns,`,
    `'->' declares a permitted dependency. Then run: npx fitc4`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Narration goes to stderr, never stdout: the report and `--json` output must
 * stay byte-identical whether narration is on or off, so a script parsing
 * stdout never sees a progress line.
 */
function narrationFor(options: Arguments): ((message: string) => void) | undefined {
  if (options.quiet) return undefined
  return (message) => {
    process.stderr.write(`${message}\n`)
  }
}

async function runDraft(options: Arguments): Promise<void> {
  const configPath = options.configPath ?? findConfig(process.cwd())
  const config = await resolveConfig(configPath)

  let describe: DraftDescribe | undefined
  if (options.describe) {
    if (config.agent === undefined) {
      throw new Error(
        `--describe needs an agent exec, and ${configPath} declares none. ` +
          `The exec lives in a module config: run 'fitc4 init --agent claude' (or codex) in a ` +
          `fresh project, or add an 'agent' field to your fitc4.config.ts/.mts ` +
          `(see node_modules/fitc4/README.md#agent-providers)`,
      )
    }
    // Imported dynamically on purpose: the core CLI path stays free of agent
    // code unless the user explicitly asked for the describe pass.
    const { draftDescriber } = await import('./agent/describe.ts')
    describe = draftDescriber({ exec: config.agent, repositoryRoot: config.repositoryRoot })
  }

  const result = await draft(config, {
    drift: !options.noDrift,
    ...(describe === undefined ? {} : { describe }),
    onProgress: narrationFor(options),
  })

  const lines: string[] = []
  if (result.written === undefined) {
    lines.push(result.text)
    lines.push(`note: ${result.refusal ?? 'the draft was not written'}`)
  } else {
    lines.push(`created ${path.relative(process.cwd(), result.written)}`)
    if (!options.noDrift) {
      lines.push(
        `every relationship is tagged as drift; run npx fitc4 to see the burn-down, ` +
          `untag an edge to bless it`,
      )
    }
  }
  if (options.describe) {
    const kept =
      result.described < result.describeAttempted
        ? result.describeAttempted - result.described
        : 0
    lines.push(
      `described ${result.described} of ${count(result.describeAttempted, 'eligible element')}` +
        (kept === 0 ? '' : `; ${count(kept, 'element')} kept the TODO`),
    )
  }
  lines.push(
    `${count(result.elements, 'element')}, ${count(result.edges, 'edge')}, ` +
      `${count(result.packages, 'package')}`,
  )
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
    runInit(options)
    return
  }
  if (options.command === 'draft') {
    await runDraft(options)
    return
  }

  // Config discovery starts at the working directory, never at this file.
  // Deriving it from `import.meta.url` works only while the tool lives in the
  // repository it checks. Installed from a package it would resolve inside
  // `node_modules` and find the wrong config, or none.
  const configPath = options.configPath ?? findConfig(process.cwd())
  const result = await runPipeline({
    ...pipelineConfig(await resolveConfig(configPath)),
    onProgress: narrationFor(options),
  })

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
