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
    const { status, stderr } = runCli(['--quiet'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: unknown option '--quiet'")
    expect(stderr).not.toContain('did you mean')
  })

  test('an unknown command is an error with a suggestion when one is close', () => {
    const { status, stderr, stdout } = runCli(['innit'])

    expect(status).toBe(1)
    expect(stderr).toContain("fitc4: unknown command 'innit', did you mean 'init'?")
    expect(stdout).toBe('')
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
