import { beforeAll, describe, expect, test } from 'vitest'

import type { PipelineResult } from '../src/pipeline.ts'
import { exitCodeFor } from '../src/report.ts'
import { findingFor, ruleIds, runFixture } from './helpers.ts'

// External-package constraints: "only infra may import pg". A `packages`
// claim maps external dependency observations onto the claiming element; the
// existing relationship rules then judge the edge with no new rule code.
describe('external-package constraints', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('packages')
  })

  test('importing a claimed package without a declared relationship is an error', () => {
    const finding = findingFor(result.findings, 'missing-relationship')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.app')
    expect(finding?.related?.[0]?.id).toBe('fixture.infra')
    // The claim gates the whole package: a subpath import maps onto it too.
    expect(finding?.evidence?.[0]?.detail).toBe('pg/promises')
  })

  test('a declared relationship permits the claimed package', () => {
    // app -> cloud is declared, so the @aws-sdk/client-s3 import is legal.
    expect(result.findings.filter((finding) => finding.description.includes('cloud'))).toEqual([])
  })

  test('an element importing the package it claims stays inside one boundary', () => {
    const association = result.associations.find(
      (item) => item.source?.id === 'fixture.infra' && item.target?.id === 'fixture.infra',
    )
    expect(association?.status).toBe('resolved')
    expect(association?.description).toContain('within its own boundary')
    expect(
      result.findings.filter((finding) => finding.subject?.id === 'fixture.infra'),
    ).toEqual([])
  })

  test('an unclaimed package stays unrestricted', () => {
    expect(result.findings.filter((finding) => finding.description.includes('lodash'))).toEqual([])
  })

  // The ratchet works on package edges exactly as on file edges.
  test('a drift-tagged relationship covers a package edge', () => {
    const drift = findingFor(result.findings, 'drift-relationship')
    expect(drift?.subject).toEqual({
      kind: 'relationship',
      id: 'fixture.legacy::_::fixture.oldstore',
    })
    expect(
      result.findings.filter(
        (finding) =>
          finding.ruleId === 'missing-relationship' &&
          finding.subject?.id === 'fixture.legacy',
      ),
    ).toEqual([])
  })

  test('only the undeclared package edge fails the gate', () => {
    expect(ruleIds(result.findings)).toEqual(['drift-relationship', 'missing-relationship'])
    expect(exitCodeFor(result)).toBe(1)
  })
})

// Every claim surface must fail loudly when it matches nothing — a claim that
// silently gates nothing makes the gate fail open.
describe('package claims that gate nothing', () => {
  let result: PipelineResult
  beforeAll(async () => {
    result = await runFixture('bad-packages')
  })

  test('each broken claim is its own error', () => {
    expect(ruleIds(result.findings)).toEqual([
      'ambiguous-package',
      'invalid-packages',
      'unmatched-packages',
    ])
  })

  test('two elements claiming one package is an error naming both', () => {
    const finding = findingFor(result.findings, 'ambiguous-package')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject).toEqual({ kind: 'module', id: 'dup-pkg' })
    expect(finding?.related?.map((ref) => ref.id)).toEqual(['fixture.a', 'fixture.b'])
  })

  test('an import of a contested package resolves to no single element', () => {
    const contested = result.associations.find((item) => item.description?.includes('dup-pkg'))
    expect(contested?.status).toBe('ambiguous')
    expect(contested?.candidates?.map((ref) => ref.id)).toEqual(['fixture.a', 'fixture.b'])
  })

  // A typo'd claim must not silently pass: the package the author meant keeps
  // being imported unrestricted while the claim gates nothing.
  test('a claim no scanned file imports is an error', () => {
    const finding = findingFor(result.findings, 'unmatched-packages')
    expect(finding?.severity).toBe('error')
    expect(finding?.subject?.id).toBe('fixture.ghost')
    expect(finding?.description).toContain('ghost-pkg')
  })

  test('a subpath is rejected with the package it should claim', () => {
    const subpath = result.findings.find(
      (finding) =>
        finding.ruleId === 'invalid-packages' && finding.subject?.id === 'fixture.deep',
    )
    expect(subpath?.severity).toBe('error')
    expect(subpath?.description).toContain("claim the package 'pg'")
  })

  test('a claim containing whitespace is rejected', () => {
    const blank = result.findings.find(
      (finding) =>
        finding.ruleId === 'invalid-packages' && finding.subject?.id === 'fixture.blank',
    )
    expect(blank?.description).toContain('contains whitespace')
  })

  test('the gate fails', () => {
    expect(exitCodeFor(result)).toBe(1)
  })
})
