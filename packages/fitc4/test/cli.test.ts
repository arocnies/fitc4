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
import { afterAll, describe, expect, test } from 'vitest'

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

/** A config file pointing at a fixture by absolute path. */
function configFor(fixture: string): string {
  const root = fixturePath(fixture)
  const configPath = path.join(tempDir(), 'fitc4.config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      repositoryRoot: root,
      model: root,
      scanRoots: ['src'],
      tsconfig: path.join(root, 'tsconfig.json'),
    }),
  )
  return configPath
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
    const configPath = path.join(tempDir(), 'fitc4.config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        repositoryRoot: root,
        model: modelDir,
        scanRoots: ['src'],
        tsconfig: path.join(root, 'tsconfig.json'),
      }),
    )

    const { status, stdout } = runCli(['draft', '--config', configPath])

    expect(status).toBe(0)
    expect(stdout).toContain('created')
    expect(stdout).toContain('untag an edge to bless it')
    expect(stdout).toContain('3 elements, 2 edges, 0 packages')
    expect(fs.readFileSync(path.join(modelDir, 'model.c4'), 'utf8')).toContain('#drift')
  })

  test('refuses to overwrite an existing model and prints the draft instead', HEAVY, () => {
    // configFor points `model` at the fixture root, which holds model.c4.
    const { status, stdout } = runCli(['draft', '--config', configFor('drift')])

    expect(status).toBe(0)
    expect(stdout).toContain('specification {')
    expect(stdout).toContain('note: model.c4 already exists')
    expect(stdout).toContain('3 elements, 2 edges, 0 packages')
  })

  test('--no-drift without the draft command is an error', () => {
    const { status, stderr } = runCli(['--no-drift'])

    expect(status).toBe(1)
    expect(stderr).toContain('fitc4: --no-drift only applies to the draft command')
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
    expect(stderr).toContain("fitc4 init --agent claude")
    expect(stderr).toContain("'agent' field")
  })

  test('with a module config declaring a stub exec, descriptions land in the draft', HEAVY, () => {
    const root = fixturePath('drift')
    const modelDir = path.join(tempDir(), 'arch')
    const configPath = path.join(tempDir(), 'fitc4.config.ts')
    fs.writeFileSync(
      configPath,
      `export default {
  version: 1,
  repositoryRoot: ${JSON.stringify(root)},
  model: ${JSON.stringify(modelDir)},
  scanRoots: ['src'],
  tsconfig: ${JSON.stringify(path.join(root, 'tsconfig.json'))},
  agent: {
    id: 'stub/model',
    run: async () => ({ ok: true, value: { description: 'Does fixture things.' }, raw: '' }),
  },
}
`,
    )

    const { status, stdout, stderr } = runCli(['draft', '--describe', '--config', configPath])

    expect(status).toBe(0)
    expect(stdout).toContain('described 3 of 3 eligible elements')
    expect(stderr).toContain('describe: app.core...')
    const model = fs.readFileSync(path.join(modelDir, 'model.c4'), 'utf8')
    expect(model).toContain(`description 'Does fixture things.'`)
    expect(model).not.toContain('TODO: what is this component responsible for?')
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
    expect(stdout).toContain('module config')
    expect(stdout).toContain('fitc4 draft --describe')
    expect(fs.readFileSync(path.join(directory, 'fitc4.config.mts'), 'utf8')).toContain(
      `claudeCli({ model: 'sonnet' })`,
    )
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
