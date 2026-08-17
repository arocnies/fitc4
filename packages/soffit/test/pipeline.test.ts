import { describe, expect, test } from 'vitest'

import { runPipeline } from '../src/pipeline.ts'
import { exitCodeFor, renderReport } from '../src/report.ts'
import { EVIDENCE_LIMIT } from '../src/providers/architecture-rules.ts'
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
  test('produces no findings and passes the gate', async () => {
    const result = await runFixture('ok')

    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
    expect(renderReport(result).exitCode).toBe(0)
  })

  test('observes both files and the import between them', async () => {
    const result = await runFixture('ok')

    const files = result.observations.filter((item) => item.kind === 'file')
    expect(files.map((item) => item.subject?.id).sort()).toEqual([
      'src/core/health.ts',
      'src/interface/index.ts',
    ])

    const dependency = result.observations.find((item) => item.kind === 'dependency')
    expect(dependency?.subject?.id).toBe('src/interface/index.ts')
    expect(dependency?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  test('resolves the import to the declared relationship', async () => {
    const result = await runFixture('ok')

    const crossing = result.associations.find((item) => item.target?.kind === 'element')
    expect(crossing?.status).toBe('resolved')
    expect(crossing?.source?.id).toBe('fixture.app.interface')
    expect(crossing?.target?.id).toBe('fixture.app.core')
    expect(crossing?.relationship?.id).toBe('fixture.app.interface::_::fixture.app.core')
  })
})

describe('a model whose implementation contradicts the contract', () => {
  test('reports each of the deterministic rules', async () => {
    const result = await runFixture('violations')

    expect(ruleIds(result.findings)).toEqual([
      'ambiguous-source',
      'missing-relationship',
      'relationship-direction',
      'unmapped-source',
    ])
  })

  test('flags the undeclared dependency and names both elements', async () => {
    const finding = findingFor((await runFixture('violations')).findings, 'missing-relationship')

    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app.extra')
    expect(finding?.related?.[0]?.id).toBe('fixture.app.core')
  })

  test('flags the backwards dependency against the declared relationship', async () => {
    const finding = findingFor((await runFixture('violations')).findings, 'relationship-direction')

    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app.core')
    expect(finding?.related).toContainEqual({
      kind: 'relationship',
      id: 'fixture.app.interface::_::fixture.app.core',
    })
  })

  test('treats an unowned file as a warning and a contested file as an error', async () => {
    const { findings } = await runFixture('violations')

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

  test('fails the gate', async () => {
    expect(renderReport(await runFixture('violations')).exitCode).toBe(1)
  })
})

describe('containment', () => {
  // LikeC4 rejects a parent-child relationship, so flagging either of these
  // would produce a violation the author cannot fix.
  test('nesting produces no violations', async () => {
    const result = await runFixture('nested')

    expect(result.findings).toEqual([])
    expect(renderReport(result).exitCode).toBe(0)
  })

  test('a child importing from its own parent is inside one boundary', async () => {
    const { associations } = await runFixture('nested')

    const association = associations.find(
      (item) => item.source?.id === 'fixture.app.core' && item.target?.id === 'fixture.app',
    )
    expect(association?.status).toBe('resolved')
    expect(association?.description).toContain('within its own boundary')
  })

  test('a leaf-to-leaf crossing resolves to the parent-level relationship', async () => {
    const { associations } = await runFixture('nested')

    const association = associations.find(
      (item) => item.source?.id === 'fixture.web.ui' && item.target?.id === 'fixture.app.core',
    )
    expect(association?.relationship?.id).toBe('fixture.web::_::fixture.app')
  })
})

describe('ownership metadata that claims nothing', () => {
  test('a prefix matching no scanned file is an error, not a silent pass', async () => {
    const { findings } = await runFixture('bad-sources')

    const unmatched = findingFor(findings, 'unmatched-sources')
    expect(unmatched?.severity).toBe('error')
    expect(unmatched?.subject?.id).toBe('fixture.ghost')
  })

  test('an unsupported glob is an error', async () => {
    const { findings } = await runFixture('bad-sources')

    const invalid = findingFor(findings, 'invalid-sources')
    expect(invalid?.severity).toBe('error')
    expect(invalid?.subject?.id).toBe('fixture.wild')
  })

  // A stray './' used to make every prefix stop matching, turning three
  // architecture errors into a green build.
  test("a leading './' still matches", async () => {
    const { findings } = await runFixture('bad-sources')

    expect(findings.some((finding) => finding.subject?.id === 'fixture.core')).toBe(false)
    expect(findings.some((finding) => finding.ruleId === 'unmapped-source')).toBe(false)
  })

  test('the gate fails', async () => {
    expect(exitCodeFor(await runFixture('bad-sources'))).toBe(1)
  })
})

describe('module reference forms', () => {
  test('every static and dynamic form is observed', async () => {
    const { observations } = await runFixture('imports')

    const kinds = observations
      .filter((item) => item.kind === 'dependency' && item.target?.kind === 'file')
      .map((item) => item.data?.['dependencyKind'])

    expect(new Set(kinds)).toEqual(new Set(['import', 're-export', 'dynamic-import', 'require']))
  })

  // Lazy-loading across a boundary is the standard way to break a static
  // cycle, so it must not escape the check.
  test('a dynamic import is a real dependency', async () => {
    const { observations } = await runFixture('imports')

    const dynamic = observations.find((item) => item.data?.['dependencyKind'] === 'dynamic-import')
    expect(dynamic?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  test('import.meta.resolve is a dependency', async () => {
    const { observations } = await runFixture('imports')

    const meta = observations.find(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/interface/meta.ts',
    )
    expect(meta?.target).toEqual({ kind: 'file', id: 'src/core/health.ts' })
  })

  // Two references to one specifier can share a line; keying only on the line
  // made the scanner emit duplicate ids and fail itself.
  test('two references on one line do not collide', async () => {
    const result = await runFixture('imports')

    expect(result.findings.filter((finding) => finding.ruleId === 'provider-failure')).toEqual([])

    const sameLine = result.observations.filter(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/interface/sameline.ts',
    )
    expect(sameLine).toHaveLength(2)
    expect(new Set(sameLine.map((item) => item.id)).size).toBe(2)
  })

  test('repeated references to one target keep their own evidence lines', async () => {
    const { observations } = await runFixture('imports')

    const toCore = observations.filter(
      (item) =>
        item.kind === 'dependency' &&
        item.subject?.id === 'src/interface/index.ts' &&
        item.target?.id === 'src/core/health.ts',
    )
    const lines = toCore.map((item) => item.evidence?.[0]?.line)

    expect(lines.length).toBeGreaterThan(3)
    expect(new Set(lines).size).toBe(lines.length)
    expect(new Set(observations.map((item) => item.id)).size).toBe(observations.length)
  })

  // Classifying a broken relative import as an external package would silently
  // drop the dependency from the architecture check.
  test('an unresolvable relative import is reported, not treated as a package', async () => {
    const { observations, findings } = await runFixture('imports')

    const broken = observations.find((item) => item.kind === 'unresolved-dependency')
    expect(broken?.target?.id).toBe('./deleted.js')
    // An external specifier is a module too — only the observation kind
    // separates "could not resolve this" from "resolves outside the model".
    expect(broken?.target?.kind).toBe('module')

    const finding = findingFor(findings, 'unresolved-import')
    expect(finding?.severity).toBe('warning')
    expect(finding?.subject?.id).toBe('src/interface/broken.ts')
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
        {
          id: TYPESCRIPT_IMPORTS_ID,
          run: typescriptImports({ tsconfigPath: fixturePath('ok/missing.json'), roots: ['src'] }),
        },
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

describe('report', () => {
  test('advisory findings are reported without failing the gate', async () => {
    const advisory: ValidateProvider = async () => [
      {
        id: 'hint',
        ruleId: 'mock/semantic-hint',
        severity: 'info',
        description: 'Interface looks like a facade over Core.',
        subject: { kind: 'element', id: 'fixture.app.interface' },
        provider: 'mock-semantic-validation',
      },
    ]

    const result = await runFixture('ok', {
      validate: [
        { id: RULES_ID, run: architectureRulesProvider() },
        { id: 'mock-semantic-validation', run: advisory },
      ],
    })
    const report = renderReport(result)

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['mock/semantic-hint'])
    expect(report.exitCode).toBe(0)
    expect(report.text).toContain('Interface looks like a facade over Core.')
  })

  test('evidence is capped so one boundary cannot bury the report', async () => {
    const crossings = EVIDENCE_LIMIT + 5
    const observations: Observation[] = []
    const associations: Association[] = []

    for (let index = 0; index < crossings; index += 1) {
      const observation: Observation = {
        id: `dependency:${index}`,
        kind: 'dependency',
        subject: { kind: 'file', id: `src/a/f${index}.ts` },
        target: { kind: 'file', id: 'src/b/g.ts' },
        evidence: [{ path: `src/a/f${index}.ts`, line: 1 }],
        provider: 'mock-scan',
      }
      observations.push(observation)
      associations.push({
        id: `association:${index}`,
        observationId: `mock-scan/dependency:${index}`,
        status: 'resolved',
        source: { kind: 'element', id: 'fixture.app.interface' },
        target: { kind: 'element', id: 'fixture.app.extra' },
        provider: 'mock-resolve',
      })
    }

    const result = await runPipeline(
      fixtureConfig('ok', {
        scan: [{ id: 'mock-scan', run: async () => observations }],
        resolve: [{ id: 'mock-resolve', run: async () => associations }],
      }),
    )

    const finding = findingFor(result.findings, 'missing-relationship')
    expect(finding?.evidence).toHaveLength(EVIDENCE_LIMIT + 1)
    expect(finding?.evidence?.at(-1)?.detail).toBe('and 5 more')
  })

  test('the scan provider keeps its own evidence array', async () => {
    const result = await runFixture('violations')

    const finding = findingFor(result.findings, 'missing-relationship')
    const observation = result.observations.find(
      (item) => item.kind === 'dependency' && item.subject?.id === 'src/extra/uses.ts',
    )
    expect(finding?.evidence).not.toBe(observation?.evidence)
  })

  test('evidence with no path renders without the literal word undefined', async () => {
    const noPath: ValidateProvider = async () => [
      {
        id: 'e',
        ruleId: 'mock/evidence',
        severity: 'info',
        description: 'detail only',
        evidence: [{ detail: 'somewhere' }],
        provider: 'mock-evidence',
      },
    ]

    const report = renderReport(
      await runFixture('ok', { validate: [{ id: 'mock-evidence', run: noPath }] }),
    )
    expect(report.text).not.toContain('undefined')
    expect(report.text).toContain('somewhere')
  })

  test('an invalid model reports the model error and does not run the pipeline', async () => {
    const result = await runPipeline(fixtureConfig('no-model'))
    const report = renderReport(result)

    expect(result.observations).toEqual([])
    expect(report.text).toContain('did not run')
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
        {
          id: TYPESCRIPT_IMPORTS_ID,
          run: typescriptImports({
            tsconfigPath: path.join(fixturePath('ok'), 'tsconfig.json'),
            roots: ['src'],
          }),
        },
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
