/**
 * The CLI layer, exercised the way a consumer hits it: a spawned process, real
 * argv, real exit codes. What lives here is argument handling — everything
 * after `resolveConfig` already has its own suites.
 *
 * A typo'd flag that silently runs the default check is the CLI-shaped
 * fail-open: `--josn` quietly loses the JSON some script was about to parse,
 * `innit` quietly checks instead of scaffolding. Unknown arguments must be
 * loud errors.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { loadModel } from '../src/model.ts'
import type { PipelineResult } from '../src/pipeline.ts'
import { fixturePath, ruleIds } from './helpers.ts'

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts')

const created: string[] = []
afterAll(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-cli-'))
  created.push(directory)
  return directory
}

/** The real entry module, importable from a temp dir outside node_modules. */
const INDEX_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'index.ts')).href

/**
 * Write a standard config module into a temp dir, pointing at a fixture by
 * absolute path. `extra` fields (say an `agent:` exec) land after the phases.
 */
function writeConfig(root: string, modelDir: string, extra = ''): string {
  const configPath = path.join(tempDir(), 'fitc4.config.mts')
  fs.writeFileSync(
    configPath,
    `import { architectureRules, sourceRoot, typescriptImports } from ${JSON.stringify(INDEX_URL)}
export default {
  version: 1,
  repositoryRoot: ${JSON.stringify(root)},
  model: ${JSON.stringify(modelDir)},
  scan: [typescriptImports({ tsconfig: ${JSON.stringify(path.join(root, 'tsconfig.json'))}, roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
${extra}}
`,
  )
  return configPath
}

/** A config file pointing at a fixture by absolute path. */
function configFor(fixture: string): string {
  const root = fixturePath(fixture)
  return writeConfig(root, root)
}

function runCli(
  args: string[],
  cwd: string = tempDir(),
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const HEAVY = { timeout: 120_000 }

describe('--json', () => {
  test('emits the parseable pipeline result and exit 0 on a clean fixture', HEAVY, () => {
    const { status, stdout } = runCli(['--json', '--config', configFor('ok')])

    expect(status).toBe(0)
    const result = JSON.parse(stdout) as PipelineResult
    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
    expect(result.providers.scan).toEqual(['typescript-imports'])
  })

  test('emits the findings and exit 1 on a violating fixture', HEAVY, () => {
    const { status, stdout } = runCli(['--json', '--config', configFor('violations')])

    expect(status).toBe(1)
    const result = JSON.parse(stdout) as PipelineResult
    expect(ruleIds(result.findings)).toContain('relationship-direction')
  })
})

describe('--config', () => {
  // The named config must win outright: discovery finding a different one
  // would check the wrong repository and report it as this one.
  test('uses the named config, not discovery', HEAVY, () => {
    const violating = configFor('violations')
    const { status } = runCli(['--config', configFor('ok')], path.dirname(violating))

    expect(status).toBe(0)
  })

  test('with no path is an error', () => {
    const { status, stderr } = runCli(['--config'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --config requires a path')
  })
})

describe('unknown arguments', () => {
  test('an unknown option is an error with a suggestion when one is close', () => {
    const { status, stderr, stdout } = runCli(['--josn'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: unknown option '--josn', did you mean '--json'?")
    expect(stdout).toBe('')
  })

  test('an unknown option with nothing close gets no guess', () => {
    const { status, stderr } = runCli(['--silent'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: unknown option '--silent'")
    expect(stderr).not.toContain('did you mean')
  })

  test('an unknown command is an error with a suggestion when one is close', () => {
    const { status, stderr, stdout } = runCli(['innit'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: unknown command 'innit', did you mean 'init'?")
    expect(stdout).toBe('')
  })
})

describe('draft', () => {
  test('writes the model, reports the drift default, and ends with the summary', HEAVY, () => {
    const root = fixturePath('drift')
    const modelDir = path.join(tempDir(), 'arch')
    const configPath = writeConfig(root, modelDir)

    const { status, stdout } = runCli(['draft', '--config', configPath])

    expect(status).toBe(0)
    expect(stdout).toContain('created')
    expect(stdout).toContain('untag an edge to bless it')
    expect(stdout).toContain('3 elements, 2 edges, 0 packages')
    expect(fs.readFileSync(path.join(modelDir, 'model.c4'), 'utf8')).toContain('#drift')
  })

  // `fitc4 draft > arch/model.c4` is exactly what a refused draft invites, so
  // stdout carries the model and nothing else: a note or a count line inside
  // that file is a corrupt model.
  test('refuses to overwrite an existing model and keeps the printed draft pure', HEAVY, () => {
    // configFor points `model` at the fixture root, which holds model.c4.
    const { status, stdout, stderr } = runCli(['draft', '--config', configFor('drift')])

    expect(status).toBe(0)
    expect(stdout).toContain('specification {')
    expect(stdout.trimEnd().endsWith('}')).toBe(true)
    expect(stdout).not.toContain('note:')
    expect(stdout).not.toMatch(/\d+ elements?, /)
    // The explanation and the counts go where every other narration line goes.
    expect(stderr).toContain('note: model.c4 already exists')
    expect(stderr).toContain('3 elements, 2 edges, 0 packages')
  })

  test('the refused draft on stdout parses as a model', HEAVY, async () => {
    const { stdout } = runCli(['draft', '--config', configFor('drift')])

    const modelDir = tempDir()
    fs.writeFileSync(path.join(modelDir, 'model.c4'), stdout)
    const loaded = await loadModel(modelDir)

    expect(loaded.errors).toEqual([])
    expect([...loaded.model.elements()].length).toBeGreaterThan(0)
  })

  test('--no-drift without the draft command is an error', () => {
    const { status, stderr } = runCli(['--no-drift'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --no-drift only applies to the draft command')
  })

  // The gate reads its tag from architectureRules({ driftTag }); a draft that
  // could only write the default tag produced debt the tuned gate never
  // counted down.
  test('--drift-tag writes the custom tag and the summary names it', HEAVY, () => {
    const root = fixturePath('drift')
    const modelDir = path.join(tempDir(), 'arch')
    const configPath = writeConfig(root, modelDir)

    const { status, stdout } = runCli(['draft', '--config', configPath, '--drift-tag', 'legacy-debt'])

    expect(status).toBe(0)
    expect(stdout).toContain('tagged as legacy-debt')
    const model = fs.readFileSync(path.join(modelDir, 'model.c4'), 'utf8')
    expect(model).toContain('tag legacy-debt')
    expect(model).toContain('#legacy-debt')
    expect(model).not.toContain('#drift')
  })

  test('--drift-tag guards: needs a value, a draft, and no --no-drift', () => {
    expect(runCli(['draft', '--drift-tag']).stderr).toContain('--drift-tag requires a tag name')
    expect(runCli(['--drift-tag', 'x']).stderr).toContain('only applies to the draft command')
    expect(runCli(['draft', '--drift-tag', 'x', '--no-drift']).stderr).toContain('contradict')
  })
})

describe('draft --describe', () => {
  test('--describe without the draft command is an error', () => {
    const { status, stderr } = runCli(['--describe'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --describe only applies to the draft command')
  })

  test('a config with no agent exec is an error naming the fix', HEAVY, () => {
    const { status, stderr } = runCli(['draft', '--describe', '--config', configFor('drift')])

    expect(status).toBe(1)
    expect(stderr).toContain('--describe needs an agent exec')
    expect(stderr).toContain("'agent' field")
    // init --agent is offered for a project with no config, not as advice to
    // someone who already has one: that routed users into the old trap where
    // init created the model that made the next draft refuse.
    expect(stderr).toContain('no config yet')
    expect(stderr).toContain('fitc4 init --agent claude')
  })

  // The failure that used to read as eleven models declining to answer.
  test('an exec that cannot run aborts the draft, exits nonzero, and writes nothing', HEAVY, () => {
    const root = fixturePath('drift')
    const modelDir = path.join(tempDir(), 'arch')
    const configPath = writeConfig(
      root,
      modelDir,
      `  agent: { id: 'stub/model', run: async () => ({ ok: false, error: 'not logged in' }) },\n`,
    )

    const { status, stdout, stderr } = runCli(['draft', '--describe', '--config', configPath])

    expect(status).toBe(1)
    expect(stderr).toContain('describe aborted at app.')
    expect(stderr).toContain('stub/model could not run: not logged in')
    expect(stdout).toBe('')
    expect(fs.existsSync(modelDir)).toBe(false)
  })

  // Abstention and success are one spawned run: the exec declines the first
  // element and describes the rest, covering both branches of the CLI's
  // summary line. The abstention/failure semantics themselves are pinned
  // in-process by draft.test.ts and agent-describe.test.ts.
  test('descriptions land, an abstention keeps its TODO, and the summary counts both', HEAVY, () => {
    const root = fixturePath('drift')
    const modelDir = path.join(tempDir(), 'arch')
    const configPath = writeConfig(
      root,
      modelDir,
      `  agent: (() => { let calls = 0; return { id: 'stub/model', run: async () => ` +
        `({ ok: true, value: { description: ++calls === 1 ? '' : 'Does fixture things.' }, raw: '' }) } })(),\n`,
    )

    const { status, stdout, stderr } = runCli(['draft', '--describe', '--config', configPath])

    expect(status).toBe(0)
    expect(stdout).toContain('described 2 of 3 eligible elements; 1 element kept the TODO')
    expect(stderr).toContain('describe: app.core...')
    const model = fs.readFileSync(path.join(modelDir, 'model.c4'), 'utf8')
    expect(model).toContain(`description 'Does fixture things.'`)
    expect(model).toContain('TODO: what is this component responsible for?')
  })
})

describe('init --agent', () => {
  test('--agent outside init is an error', () => {
    const { status, stderr } = runCli(['--agent', 'claude'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --agent only applies to the init command')
  })

  test('an unknown agent is an error listing the accepted CLIs', () => {
    const { status, stderr } = runCli(['init', '--agent', 'gemini'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: --agent requires one of: claude, codex; got 'gemini'")
  })

  test('a missing agent value is an error listing the accepted CLIs', () => {
    const { status, stderr } = runCli(['init', '--agent'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --agent requires one of: claude, codex')
  })

  test('init --agent scaffolds the module config and says what that unlocks', () => {
    const directory = tempDir()
    const { status, stdout } = runCli(['init', '--agent', 'claude'], directory)

    expect(status).toBe(0)
    expect(stdout).toContain('created fitc4.config.mts')
    expect(stdout).toContain("config's agent exec")
    // The next step is the point of this path, and the caveat is stated here
    // too, not only inside the file.
    expect(stdout).toContain('Next: npx fitc4 draft --describe')
    expect(stdout).toContain('fail in CI without a login')
    expect(fs.readFileSync(path.join(directory, 'fitc4.config.mts'), 'utf8')).toContain(
      `claudeCli({ model: 'sonnet' })`,
    )
  })
})

describe('init', () => {
  // The plain path is also how a brownfield user arrives, and a hand-written
  // model of an existing codebase is the harder way in.
  test('the plain path names the model file first and draft as the brownfield way in', () => {
    const { status, stdout } = runCli(['init'], tempDir())

    expect(status).toBe(0)
    expect(stdout).toContain(`put your elements in arch/model.c4`)
    expect(stdout).toContain('npx fitc4 draft')
  })

  // init used to create the very file that made the next command refuse.
  test('a draft straight after init replaces the placeholder it wrote', HEAVY, () => {
    const directory = tempDir()
    fs.mkdirSync(path.join(directory, 'src'))
    fs.writeFileSync(path.join(directory, 'src', 'index.ts'), 'export const started = true\n')
    fs.writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    )
    expect(runCli(['init'], directory).status).toBe(0)
    // The scaffold imports the package by name, which cannot resolve from a
    // temp dir outside any node_modules; point it at the real entry module.
    const scaffolded = path.join(directory, 'fitc4.config.mts')
    fs.writeFileSync(
      scaffolded,
      fs.readFileSync(scaffolded, 'utf8').replace(`from 'fitc4'`, `from '${INDEX_URL}'`),
    )

    const { status, stdout } = runCli(['draft'], directory)

    expect(status).toBe(0)
    // "created" here would hide the one case where a draft overwrites a file,
    // from the reader most likely to wonder whether theirs was clobbered.
    expect(stdout).toContain("replaced arch/model.c4 (it held init's untouched placeholder)")
    expect(stdout).not.toContain('created arch/model.c4')
    const model = fs.readFileSync(path.join(directory, 'arch', 'model.c4'), 'utf8')
    expect(model).not.toContain('fitc4 init placeholder')
    expect(model).toContain(`sources 'src/**'`)

    // And the drafted model is authored territory now: a second draft refuses.
    const second = runCli(['draft'], directory)
    expect(second.stderr).toContain('never overwrites')
    expect(fs.readFileSync(path.join(directory, 'arch', 'model.c4'), 'utf8')).toBe(model)
  })
})

describe('narration', () => {
  // Narration is stderr-only, so the report and --json stay byte-identical
  // whether it is on, off, or piped away.
  test('a default run narrates the phases on stderr, never stdout', HEAVY, () => {
    const { status, stdout, stderr } = runCli(['--config', configFor('ok')])

    expect(status).toBe(0)
    expect(stderr).toContain('scan: typescript-imports...')
    expect(stderr).toContain('validate: architecture-rules done')
    expect(stdout).not.toContain('typescript-imports...')
  })

  test('--json keeps stdout parseable with narration on stderr', HEAVY, () => {
    const { status, stdout, stderr } = runCli(['--json', '--config', configFor('ok')])

    expect(status).toBe(0)
    expect(stderr).toContain('scan: typescript-imports...')
    expect((JSON.parse(stdout) as PipelineResult).modelErrors).toEqual([])
  })

  test('--quiet suppresses the narration entirely', HEAVY, () => {
    const { status, stderr } = runCli(['--quiet', '--config', configFor('ok')])

    expect(status).toBe(0)
    expect(stderr).toBe('')
  })

  test('draft narrates its scan on stderr too', HEAVY, () => {
    const { status, stdout, stderr } = runCli(['draft', '--config', configFor('drift')])

    expect(status).toBe(0)
    expect(stderr).toContain('scan: typescript-imports...')
    expect(stdout).not.toContain('typescript-imports...')
  })
})

describe('--help', () => {
  test('prints usage and exits 0', () => {
    const { status, stdout } = runCli(['--help'])

    expect(status).toBe(0)
    expect(stdout).toContain('Usage: fitc4')
    expect(stdout).toContain('--config <path>')
  })
})
