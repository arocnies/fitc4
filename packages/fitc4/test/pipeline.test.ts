import { beforeAll, describe, expect, test } from 'vitest'

import { runPipeline, type PipelineResult } from '../src/pipeline.ts'
import { exitCodeFor, renderReport } from '../src/report.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import { typescriptImports } from '../src/providers/typescript-imports.ts'
import type { Association, Finding, Observation, ResolveProvider, ValidateProvider } from '../src/types.ts'
import {
  findingFor,
  fixtureConfig,
  fixturePath,
  ruleIds,
  runFixture,
  RULES_ID,
  TYPESCRIPT_IMPORTS_ID,
} from './helpers.ts'
import path from 'node:path'

describe('a model whose implementation matches the contract', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('ok')
  })

  test('produces no findings and passes the gate', () => {
    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
    expect(renderReport(result).exitCode).toBe(0)
  })

  test('observes both files and the import between them', () => {
    const files = result.observations.filter((item) => item.kind === 'file')
    expect(files.map((item) => item.subject?.id).sort()).toEqual([
      'src/core/health.ts',
      'src/interface/index.ts',
    ])

    const dependency = result.observations.find((item) => item.kind === 'dependency')
    expect(dependency?.subject?.id).toBe('src/interface/index.ts')
    expect(dependency?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  test('resolves the import to the declared relationship', () => {
    const crossing = result.associations.find((item) => item.target?.kind === 'element')
    expect(crossing?.status).toBe('resolved')
    expect(crossing?.source?.id).toBe('fixture.app.interface')
    expect(crossing?.target?.id).toBe('fixture.app.core')
    expect(crossing?.relationship?.id).toBe('fixture.app.interface::_::fixture.app.core')
  })
})

describe('a model whose implementation contradicts the contract', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('violations')
  })

  test('reports each of the deterministic rules', () => {
    expect(ruleIds(result.findings)).toEqual([
      'ambiguous-source',
      'missing-relationship',
      'relationship-direction',
      'unmapped-source',
    ])
  })

  test('flags the undeclared dependency and names both elements', () => {
    const finding = findingFor(result.findings, 'missing-relationship')

    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app.extra')
    expect(finding?.related?.[0]?.id).toBe('fixture.app.core')
  })

  test('flags the backwards dependency against the declared relationship', () => {
    const finding = findingFor(result.findings, 'relationship-direction')

    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app.core')
    expect(finding?.related).toContainEqual({
      kind: 'relationship',
      id: 'fixture.app.interface::_::fixture.app.core',
    })
    // The remedy names the code fix only. The model is the contract; whether
    // it should change is a design decision that belongs to the shipped
    // norms, not to a message an agent acts on directly. An earlier wording
    // named the model edit here and read as an invitation.
    expect(finding?.description).toContain('Reroute or remove the import')
    expect(finding?.description).not.toContain('declare the dependency')
  })

  test('treats an unowned file as a warning and a contested file as an error', () => {
    const { findings } = result

    const unmapped = findingFor(findings, 'unmapped-source')
    expect(unmapped?.severity).toBe('warning')
    expect(unmapped?.subject?.id).toBe('src/orphan/thing.ts')

    const ambiguous = findingFor(findings, 'ambiguous-source')
    expect(ambiguous?.severity).toBe('error')
    expect(ambiguous?.related?.map((ref) => ref.id)).toEqual([
      'fixture.app.sharedA',
      'fixture.app.sharedB',
    ])
  })

  test('fails the gate', () => {
    expect(renderReport(result).exitCode).toBe(1)
  })
})

describe('containment', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('nested')
  })

  // LikeC4 rejects a parent-child relationship, so flagging either of these
  // would produce a violation the author cannot fix.
  test('nesting produces no violations', () => {
    expect(result.findings).toEqual([])
    expect(renderReport(result).exitCode).toBe(0)
  })

  test('a child importing from its own parent is inside one boundary', () => {
    const { associations } = result

    const association = associations.find(
      (item) => item.source?.id === 'fixture.app.core' && item.target?.id === 'fixture.app',
    )
    expect(association?.status).toBe('resolved')
    expect(association?.description).toContain('within its own boundary')
  })

  test('a leaf-to-leaf crossing resolves to the parent-level relationship', () => {
    const { associations } = result

    const association = associations.find(
      (item) => item.source?.id === 'fixture.web.ui' && item.target?.id === 'fixture.app.core',
    )
    expect(association?.relationship?.id).toBe('fixture.web::_::fixture.app')
  })
})

describe('ownership metadata that claims nothing', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('bad-sources')
  })

  test('a prefix matching no scanned file is an error, not a silent pass', () => {
    const unmatched = findingFor(result.findings, 'unmatched-sources')
    expect(unmatched?.severity).toBe('error')
    expect(unmatched?.subject?.id).toBe('fixture.ghost')
  })

  test('an unsupported glob is an error', () => {
    const invalid = findingFor(result.findings, 'invalid-sources')
    expect(invalid?.severity).toBe('error')
    expect(invalid?.subject?.id).toBe('fixture.wild')
  })

  // A stray './' used to make every prefix stop matching, turning three
  // architecture errors into a green build.
  test("a leading './' still matches", () => {
    const { findings } = result

    expect(findings.some((finding) => finding.subject?.id === 'fixture.core')).toBe(false)
    expect(findings.some((finding) => finding.ruleId === 'unmapped-source')).toBe(false)
  })

  test('the gate fails', () => {
    expect(exitCodeFor(result)).toBe(1)
  })
})

describe('model hygiene', () => {
  // LikeC4 permits identical source/kind/target triples, which collapse onto
  // one stable id; the collision must surface rather than silently drop.
  test('duplicate relationship declarations are reported at info', async () => {
    const result = await runFixture('duplicates')

    expect(ruleIds(result.findings)).toEqual(['duplicate-relationship'])
    const finding = findingFor(result.findings, 'duplicate-relationship')
    expect(finding?.severity).toBe('info')
    expect(finding?.subject).toEqual({
      kind: 'relationship',
      id: 'fixture.app.interface::_::fixture.app.core',
    })
    expect(finding?.description).toContain('2 relationships')
    // Redundant, not wrong: the gate still passes.
    expect(exitCodeFor(result)).toBe(0)
  })
})

// A specifier that fails to resolve is only "external" when it is demonstrably
// not our code: a Node builtin, or a package a manifest declares. Anything
// else classified external silently drops a dependency from the check — a
// wrong tsconfig `paths` map must not turn every alias import green.
describe('unresolvable non-relative specifiers', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('phantom')
  })

  test('a tsconfig paths alias that no longer maps is reported', () => {
    const { observations, findings } = result

    const aliased = observations.find((item) => item.target?.id === '@app/missing.js')
    expect(aliased?.kind).toBe('unresolved-dependency')

    const finding = findings.find(
      (item) =>
        item.ruleId === 'unresolved-import' && item.description.includes('@app/missing.js'),
    )
    expect(finding?.severity).toBe('warning')
  })

  test('a working paths alias still resolves into the repository', () => {
    const { observations } = result

    const real = observations.find((item) => item.data?.['specifier'] === '@app/real.js')
    expect(real?.kind).toBe('dependency')
    expect(real?.target).toEqual({ kind: 'file', id: 'src/app/real.ts' })
  })

  test('an undeclared package that does not resolve is reported', () => {
    const { observations } = result

    const phantom = observations.find((item) => item.target?.id === 'phantom-pkg')
    expect(phantom?.kind).toBe('unresolved-dependency')
  })

  test('a declared package without type declarations stays external', () => {
    const { observations, findings } = result

    const untyped = observations.find((item) => item.target?.id === 'untyped-pkg')
    expect(untyped?.kind).toBe('dependency')
    expect(untyped?.data?.['external']).toBe(true)
    expect(findings.filter((item) => item.description.includes('untyped-pkg'))).toEqual([])
  })

  test('node builtins stay external and unreported', () => {
    const { observations, findings } = result

    const builtin = observations.find((item) => item.data?.['specifier'] === 'node:path')
    expect(builtin?.kind).toBe('dependency')
    expect(findings.filter((item) => item.description.includes('node:path'))).toEqual([])
  })
})

describe('coverage does not depend on import reachability', () => {
  // A Program seeded from tsconfig only contains included files plus what they
  // import, so a file nobody imports would never be reported as unowned.
  test('a file outside the tsconfig include is still scanned', async () => {
    const { observations } = await runFixture('violations')

    const files = observations
      .filter((item) => item.kind === 'file')
      .map((item) => item.subject?.id)
    expect(files).toContain('src/orphan/thing.ts')
  })

  test('an npm workspace package is repository code, not an external package', async () => {
    const { observations } = await runFixture('monorepo', {}, ['src', 'packages'])

    const dependency = observations.find((item) => item.kind === 'dependency')
    expect(dependency?.target).toEqual({ kind: 'file', id: 'packages/lib/index.ts' })
    expect(dependency?.data?.['external']).toBe(false)
  })

  test('the workspace crossing is checked against the model', async () => {
    const { findings } = await runFixture('monorepo', {}, ['src', 'packages'])

    const finding = findingFor(findings, 'missing-relationship')
    expect(finding?.subject?.id).toBe('fixture.app')
    expect(finding?.related?.[0]?.id).toBe('fixture.lib')
  })
})

describe('provider failure', () => {
  const failing: ValidateProvider = async () => {
    throw new Error('provider exploded')
  }

  test('becomes an error finding and does not stop other providers', async () => {
    const result = await runFixture('ok', {
      validate: [
        { id: 'mock-throwing-validation', run: failing },
        { id: RULES_ID, run: architectureRulesProvider() },
      ],
    })

    const failure = findingFor(result.findings, 'provider-failure')
    expect(failure?.severity).toBe('error')
    expect(failure?.provider).toBe('arch')
    expect(failure?.description).toContain('mock-throwing-validation')
    expect(failure?.description).toContain('provider exploded')

    expect(result.observations.length).toBeGreaterThan(0)
    expect(renderReport(result).exitCode).toBe(1)
  })

  test('a scan failure produces one error rather than a cascade', async () => {
    const result = await runFixture('ok', {
      scan: [
        typescriptImports({ tsconfig: fixturePath('ok/missing.json'), roots: ['src'] }),
      ],
    })

    expect(result.observations).toEqual([])
    expect(result.associations).toEqual([])
    expect(ruleIds(result.findings)).toEqual(['provider-failure'])
    expect(exitCodeFor(result)).toBe(1)
  })

  test('the same provider id failing in two phases yields two distinct findings', async () => {
    const throwingResolve: ResolveProvider = async () => {
      throw new Error('resolve failed')
    }
    const result = await runFixture('ok', {
      resolve: [{ id: 'dual', run: throwingResolve }],
      validate: [{ id: 'dual', run: failing }],
    })

    const failures = result.findings.filter((finding) => finding.ruleId === 'provider-failure')
    expect(failures).toHaveLength(2)
    expect(new Set(failures.map((finding) => finding.id)).size).toBe(2)
  })
})

describe('malformed provider output', () => {
  test.each([
    ['a cycle', () => { const value: Record<string, unknown> = {}; value['self'] = value; return value }],
    ['undefined', () => ({ missing: undefined })],
    ['a function', () => ({ run: () => 1 })],
    ['a symbol', () => ({ tag: Symbol('x') })],
    ['a Map', () => ({ entries: new Map() })],
    ['a Date', () => ({ at: new Date(0) })],
    ['NaN', () => ({ score: Number.NaN })],
    ['a bigint', () => ({ big: 1n })],
  ])('data containing %s fails only that provider', async (_label, build) => {
    const bad: ValidateProvider = async () => [
      {
        id: 'bad',
        ruleId: 'mock/bad-data',
        severity: 'info',
        description: 'carries unserializable data',
        data: build() as never,
        provider: 'mock-invalid-provider',
      },
    ]

    const result = await runFixture('ok', {
      validate: [
        { id: 'mock-invalid-provider', run: bad },
        { id: RULES_ID, run: architectureRulesProvider() },
      ],
    })

    expect(findingFor(result.findings, 'provider-failure')?.description).toContain(
      'mock-invalid-provider',
    )
    expect(result.findings.some((finding) => finding.ruleId === 'mock/bad-data')).toBe(false)
  })

  // Half a provider's output is not a result, it is a misleading one.
  test('a provider that fails partway contributes nothing', async () => {
    const partial = async (): Promise<Observation[]> => [
      { id: 'a', kind: 'file', subject: { kind: 'file', id: 'a.ts' }, provider: 'mock-partial' },
      { id: 'b', kind: 'file', subject: { kind: 'file', id: 'b.ts' }, provider: 'mock-partial' },
      { id: 'a', kind: 'file', subject: { kind: 'file', id: 'a.ts' }, provider: 'mock-partial' },
      { id: 'c', kind: 'file', subject: { kind: 'file', id: 'c.ts' }, provider: 'mock-partial' },
    ]

    const result = await runFixture('ok', { scan: [{ id: 'mock-partial', run: partial }] })

    expect(result.observations).toEqual([])
    expect(findingFor(result.findings, 'provider-failure')?.description).toContain('duplicate id')
  })

  test('a duplicate id fails the provider instead of silently overwriting', async () => {
    const duplicating: ValidateProvider = async () => {
      const finding: Finding = {
        id: 'same',
        ruleId: 'mock/dup',
        severity: 'info',
        description: 'twice',
        provider: 'mock-duplicate',
      }
      return [finding, { ...finding }]
    }

    const result = await runFixture('ok', {
      validate: [{ id: 'mock-duplicate', run: duplicating }],
    })

    expect(findingFor(result.findings, 'provider-failure')?.description).toContain(
      'duplicate id',
    )
  })

  // A resolve provider that rebuilds the natural key instead of copying the
  // namespaced id would otherwise drop every association and exit 0.
  test('associations referencing unknown observations are reported', async () => {
    const detached: ResolveProvider = async (context) =>
      context.observations.map(
        (observation, index): Association => ({
          id: `detached:${index}`,
          observationId: `file:${observation.subject?.id ?? index}`,
          status: 'resolved',
          provider: 'mock-detached-resolve',
        }),
      )

    const result = await runFixture('ok', {
      resolve: [{ id: 'mock-detached-resolve', run: detached }],
    })

    const orphaned = findingFor(result.findings, 'orphaned-association')
    expect(orphaned?.severity).toBe('error')
    expect(orphaned?.description).toContain('mock-detached-resolve')
    expect(exitCodeFor(result)).toBe(1)
  })

  test('an unknown severity is forced to error rather than vanishing', async () => {
    const shouting: ValidateProvider = async () => [
      {
        id: 'critical',
        ruleId: 'mock/critical',
        severity: 'critical' as never,
        description: 'should not disappear',
        provider: 'mock-severity',
      },
    ]

    const result = await runFixture('ok', { validate: [{ id: 'mock-severity', run: shouting }] })
    const report = renderReport(result)

    expect(result.findings[0]?.severity).toBe('error')
    expect(report.text).toContain('should not disappear')
    expect(report.exitCode).toBe(1)
  })
})

describe('the gate', () => {
  test.each(['ok', 'violations', 'nested', 'bad-sources', 'imports', 'no-model'])(
    'text and json agree on %s',
    async (fixture) => {
      const result = await runPipeline(fixtureConfig(fixture))
      expect(exitCodeFor(result)).toBe(renderReport(result).exitCode)
    },
  )
})

describe('identifier namespacing', () => {
  test('two scan providers emitting the same natural key do not collide', async () => {
    const duplicate = async (): Promise<Observation[]> => [
      {
        id: 'file:src/core/health.ts',
        kind: 'file',
        subject: { kind: 'file', id: 'src/core/health.ts' },
        provider: 'mock-semantic-scan',
      },
    ]

    const result = await runFixture('ok', {
      scan: [
        typescriptImports({
          tsconfig: path.join(fixturePath('ok'), 'tsconfig.json'),
          roots: ['src'],
        }),
        { id: 'mock-semantic-scan', run: duplicate },
      ],
    })

    // Without this the test passes vacuously: a collision inside source-root
    // throws, the duplicate never reaches `associations`, and uniqueness holds
    // over an array that is missing the very rows under test.
    expect(result.findings.filter((finding) => finding.ruleId === 'provider-failure')).toEqual([])

    const observationIds = result.observations.map((item) => item.id)
    expect(new Set(observationIds).size).toBe(observationIds.length)
    expect(observationIds).toContain('typescript-imports/file:src/core/health.ts')
    expect(observationIds).toContain('mock-semantic-scan/file:src/core/health.ts')

    const associationIds = result.associations.map((item) => item.id)
    expect(new Set(associationIds).size).toBe(associationIds.length)

    // Both observations of the same file must reach the resolve phase.
    const forHealth = result.associations.filter(
      (item) => item.observationId.endsWith('file:src/core/health.ts'),
    )
    expect(forHealth).toHaveLength(2)
  })
})

describe('scan roots', () => {
  // The mirror image of unmatched ownership metadata: a wrong root reduces
  // coverage to nothing, and every violation disappears into a green build.
  test.each([
    ['a renamed root', ['sources']],
    ['a typo', ['src/typo']],
    ['no roots at all', []],
  ])('%s fails loudly instead of scanning nothing', async (_label, roots) => {
    const result = await runFixture('violations', {}, roots)

    expect(ruleIds(result.findings)).toEqual(['provider-failure'])
    expect(exitCodeFor(result)).toBe(1)
  })

  test('a root that exists but holds no TypeScript is an error', async () => {
    const result = await runFixture('violations', {}, ['docs'])

    expect(findingFor(result.findings, 'provider-failure')?.description).toContain(
      'contains no TypeScript source',
    )
    expect(exitCodeFor(result)).toBe(1)
  })

  // A component may own code outside the scan roots — the same legal state as
  // an element with no `sources`. Reporting it leaves no fix but deleting
  // truthful metadata.
  test('ownership outside the scan roots is not reported as unmatched', async () => {
    const result = await runFixture('ok', {}, ['src/core'])

    expect(findingFor(result.findings, 'unmatched-sources')).toBeUndefined()
    expect(exitCodeFor(result)).toBe(0)
  })

  test('the covered roots are recorded as observations', async () => {
    const { observations } = await runFixture('ok')

    const roots = observations.filter((item) => item.kind === 'scan-root')
    expect(roots.map((item) => item.subject?.id)).toEqual(['src'])
    expect(roots[0]?.data?.['files']).toBe(2)
  })
})

// A scanner that speaks its own vocabulary is legal, but a scanner that means
// `dependency` and says `import` produces zero findings and exit 0 — the same
// clean report a genuinely clean repository gets.
describe('the shared kind vocabulary', () => {
  const foreign: Observation[] = [
    {
      id: 'x',
      kind: 'import',
      subject: { kind: 'file', id: 'src/interface/index.ts' },
      target: { kind: 'file', id: 'src/core/health.ts' },
      provider: 'mock-foreign',
    },
    {
      id: 'y',
      kind: 'import',
      subject: { kind: 'file', id: 'src/core/health.ts' },
      target: { kind: 'file', id: 'src/interface/index.ts' },
      provider: 'mock-foreign',
    },
  ]

  test('an unrecognized observation kind is reported rather than ignored', async () => {
    const result = await runFixture('ok', {
      scan: [{ id: 'mock-foreign', run: async () => foreign }],
    })

    const finding = findingFor(result.findings, 'unknown-observation-kind')
    expect(finding?.severity).toBe('info')
    expect(finding?.subject).toEqual({ kind: 'provider', id: 'mock-foreign' })
    // One finding per kind per provider, not one per observation.
    expect(finding?.description).toContain('2 observation(s) of kind')
    expect(
      result.findings.filter((item) => item.ruleId === 'unknown-observation-kind'),
    ).toHaveLength(1)
  })

  test('speaking the standard kinds is what buys the standard rules', async () => {
    const result = await runFixture('ok', {
      scan: [
        {
          id: 'mock-standard',
          run: async () => foreign.map((item) => ({ ...item, kind: 'dependency' })),
        },
      ],
    })

    expect(findingFor(result.findings, 'unknown-observation-kind')).toBeUndefined()
    // The model declares interface → core, so the second observation is the
    // dependency modelled backwards. The standard rules see it only because
    // the scanner used the standard kind.
    expect(findingFor(result.findings, 'relationship-direction')?.subject?.id).toBe(
      'fixture.app.core',
    )
  })
})

function architectureRulesProvider() {
  return fixtureConfig('ok').validate[0]?.run as ValidateProvider
}
