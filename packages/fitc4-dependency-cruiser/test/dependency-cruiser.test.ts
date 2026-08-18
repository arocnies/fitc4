import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'

import {
  defaultResolve,
  defaultValidate,
  isStandardObservationKind,
  renderReport,
  runPipeline,
  type Observation,
  type PipelineResult,
} from 'fitc4'
import { dependencyCruiser, isTestPath, PROVIDER_ID } from '../src/index.ts'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

const JS_APP = path.join(FIXTURES, 'js-app')
const VIOLATION = path.join(FIXTURES, 'violation')

function scan(repositoryRoot: string, roots?: string[]): Promise<Observation[]> {
  const provider = dependencyCruiser(roots === undefined ? {} : { roots })
  return provider.run({ repositoryRoot })
}

describe('the provider', () => {
  test('is named for composition under its own id', () => {
    const provider = dependencyCruiser()
    expect(provider.id).toBe('dependency-cruiser')
    expect(PROVIDER_ID).toBe('dependency-cruiser')
    expect(typeof provider.run).toBe('function')
  })
})

describe('observation vocabulary', () => {
  let observations: Observation[]

  beforeAll(async () => {
    observations = await scan(JS_APP, ['src'])
  })

  function byId(id: string): Observation | undefined {
    return observations.find((observation) => observation.id === id)
  }

  test('emits one file observation per non-test source file, as repository-relative POSIX paths', () => {
    const files = observations.filter((observation) => observation.kind === 'file')

    expect(files.map((observation) => observation.subject?.id)).toEqual([
      'src/app.mjs',
      'src/index.js',
      'src/lib.js',
    ])
    expect(byId('file:src/lib.js')).toEqual({
      id: 'file:src/lib.js',
      kind: 'file',
      subject: { kind: 'file', id: 'src/lib.js' },
      evidence: [{ path: 'src/lib.js' }],
      provider: PROVIDER_ID,
    })
  })

  test('resolves an internal require to a file-target dependency', () => {
    expect(byId('dependency:src/index.js->./lib.js')).toEqual({
      id: 'dependency:src/index.js->./lib.js',
      kind: 'dependency',
      subject: { kind: 'file', id: 'src/index.js' },
      target: { kind: 'file', id: 'src/lib.js' },
      description: 'src/index.js depends on src/lib.js',
      evidence: [{ path: 'src/index.js', detail: './lib.js' }],
      data: { specifier: './lib.js', dependencyKind: 'require', external: false, resolved: true },
      provider: PROVIDER_ID,
    })
  })

  test('resolves an internal ESM import the same way', () => {
    const dependency = byId('dependency:src/app.mjs->./lib.js')

    expect(dependency?.kind).toBe('dependency')
    expect(dependency?.target).toEqual({ kind: 'file', id: 'src/lib.js' })
    expect(dependency?.data).toEqual({
      specifier: './lib.js',
      dependencyKind: 'import',
      external: false,
      resolved: true,
    })
  })

  test('marks a node_modules package as an external dependency', () => {
    expect(byId('dependency:src/index.js->semver')).toEqual({
      id: 'dependency:src/index.js->semver',
      kind: 'dependency',
      subject: { kind: 'file', id: 'src/index.js' },
      target: { kind: 'module', id: 'semver' },
      description: 'src/index.js depends on external module semver',
      evidence: [{ path: 'src/index.js', detail: 'semver' }],
      data: { specifier: 'semver', dependencyKind: 'require', external: true, resolved: true },
      provider: PROVIDER_ID,
    })
  })

  test('marks a Node builtin external, under the specifier as written', () => {
    const dependency = byId('dependency:src/app.mjs->node:path')

    expect(dependency?.kind).toBe('dependency')
    expect(dependency?.target).toEqual({ kind: 'module', id: 'node:path' })
    expect(dependency?.data).toEqual({
      specifier: 'node:path',
      dependencyKind: 'import',
      external: true,
      resolved: true,
    })
  })

  test('flags an unresolvable relative import as unresolved-dependency', () => {
    expect(byId('dependency:src/index.js->./missing.js')).toEqual({
      id: 'dependency:src/index.js->./missing.js',
      kind: 'unresolved-dependency',
      subject: { kind: 'file', id: 'src/index.js' },
      target: { kind: 'module', id: './missing.js' },
      description: 'src/index.js references ./missing.js, which does not resolve',
      evidence: [{ path: 'src/index.js', detail: './missing.js' }],
      data: {
        specifier: './missing.js',
        dependencyKind: 'require',
        external: false,
        resolved: false,
      },
      provider: PROVIDER_ID,
    })
  })

  test('attests each scan root, counting every module it covered', () => {
    // 4 = the three observed sources plus the excluded test file: coverage
    // counts what the cruise looked at, mirroring the built-in scanner.
    expect(byId('scan-root:src')).toEqual({
      id: 'scan-root:src',
      kind: 'scan-root',
      subject: { kind: 'directory', id: 'src' },
      description: 'src is under architecture control',
      data: { files: 4 },
      provider: PROVIDER_ID,
    })
  })

  test('emits only standard observation kinds the default rules can read', () => {
    for (const observation of observations) {
      expect(isStandardObservationKind(observation.kind)).toBe(true)
    }
  })

  test('excludes test files, like the built-in scanner', () => {
    expect(isTestPath('src/__tests__/index.test.js')).toBe(true)
    const mentionsTests = observations.filter(
      (observation) =>
        observation.subject?.id.includes('__tests__') === true ||
        observation.target?.id.includes('__tests__') === true,
    )
    expect(mentionsTests).toEqual([])
  })
})

describe('fail closed', () => {
  test('an empty roots array throws instead of observing nothing', async () => {
    await expect(scan(JS_APP, [])).rejects.toThrow(/no scan roots configured/)
  })

  test('a root that is not a directory throws', async () => {
    await expect(scan(JS_APP, ['does-not-exist'])).rejects.toThrow(
      /scan root 'does-not-exist' is not a directory/,
    )
  })

  test('a root that exists but yields no modules throws instead of passing silently', async () => {
    // dependency-cruiser returns an empty module list for this — a result
    // indistinguishable from a clean run, which is exactly what must not pass.
    const empty = path.join(JS_APP, 'empty-root')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'README.md'), 'nothing cruisable here\n')
    try {
      await expect(scan(JS_APP, ['empty-root'])).rejects.toThrow(
        /scan root 'empty-root' contains no modules/,
      )
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  test('a scanner failure surfaces as a provider-failure finding, not a clean run', async () => {
    const result = await runPipeline({
      repositoryRoot: VIOLATION,
      modelDir: VIOLATION,
      scan: [dependencyCruiser({ roots: ['does-not-exist'] })],
      resolve: [...defaultResolve],
      validate: [...defaultValidate],
    })

    const failure = result.findings.find((finding) => finding.ruleId === 'provider-failure')
    expect(failure?.severity).toBe('error')
    expect(failure?.subject).toEqual({ kind: 'provider', id: PROVIDER_ID })
    expect(renderReport(result).exitCode).toBe(1)
  })
})

describe('the full pipeline over a JS project', () => {
  let result: PipelineResult

  beforeAll(async () => {
    result = await runPipeline({
      repositoryRoot: VIOLATION,
      modelDir: VIOLATION,
      scan: [dependencyCruiser({ roots: ['src'] })],
      resolve: [...defaultResolve],
      validate: [...defaultValidate],
    })
  })

  test('the boundary violation is the only finding, and it fails the gate', () => {
    expect(result.modelErrors).toEqual([])
    expect([...new Set(result.findings.map((finding) => finding.ruleId))]).toEqual([
      'relationship-direction',
    ])

    const finding = result.findings[0]
    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app.core')
    expect(renderReport(result).exitCode).toBe(1)
  })

  test('the declared direction resolves onto the model relationship', () => {
    const crossing = result.associations.find(
      (association) =>
        association.status === 'resolved' &&
        association.source?.id === 'fixture.app.interface' &&
        association.target?.id === 'fixture.app.core',
    )
    expect(crossing?.relationship?.id).toBe('fixture.app.interface::_::fixture.app.core')
  })
})
