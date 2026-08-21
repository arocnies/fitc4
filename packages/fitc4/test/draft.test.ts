/**
 * `draft` is judged by its promise: the generated model parses under the
 * bundled likec4, the very first gate run on it is green, and the observed
 * debt shows up as the drift burn-down rather than as errors.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import type { ResolvedConfig } from '../src/config.ts'
import { draft } from '../src/draft.ts'
import { pipelineConfig } from '../src/defaults.ts'
import { runPipeline } from '../src/pipeline.ts'
import type { Observation, ScanContext } from '../src/types.ts'
import { fixturePath, ruleIds } from './helpers.ts'

const HEAVY = { timeout: 120_000 }

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-draft-'))
  roots.push(root)
  return root
}

/** A config pointing at a fixture's sources with a scratch model directory. */
function configFor(fixture: string): ResolvedConfig {
  const root = fixturePath(fixture)
  return {
    repositoryRoot: root,
    modelDir: scratch(),
    scanRoots: ['src'],
    tsconfigPath: path.join(root, 'tsconfig.json'),
  }
}

function errors(findings: { severity: string }[]): unknown[] {
  return findings.filter((finding) => finding.severity === 'error')
}

describe('draft', () => {
  test('drafts one element per directory and gates green with the debt as drift', HEAVY, async () => {
    const config = configFor('drift')
    const result = await draft(config)

    expect(result.written).toBe(path.join(config.modelDir, 'model.c4'))
    expect(result.refusal).toBeUndefined()
    expect(result.elements).toBe(3)
    expect(result.edges).toBe(2)
    expect(result.packages).toBe(0)

    // One element per first-level directory, each claiming its prefix, each
    // with a placeholder description in init's TODO style.
    expect(result.text).toContain(`sources 'src/core/**'`)
    expect(result.text).toContain(`sources 'src/interface/**'`)
    expect(result.text).toContain(`sources 'src/legacy/**'`)
    expect(result.text).toContain('TODO: what is this component responsible for?')
    // No files sit directly in src/, so no catch-all element appears.
    expect(result.text).not.toContain(`sources 'src/**'`)
    // No external packages observed, so no stub element appears.
    expect(result.text).not.toContain('packages')
    // The dependency count rides a trailing comment, correctly pluralized.
    expect(result.text).toContain('app.interface -> app.core { #drift } // 1 dependency')
    expect(result.text).toContain('app.legacy -> app.core { #drift } // 2 dependencies')

    // The proof: the real pipeline on the drafted model is green, and every
    // observed crossing is a counted drift edge rather than an error.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(2)
    expect(gate.findings.filter((finding) => finding.ruleId === 'unused-drift')).toEqual([])
  })

  test('claims observed external packages on one stub element', HEAVY, async () => {
    const config = configFor('packages')
    const result = await draft(config)

    expect(result.elements).toBe(4)
    expect(result.edges).toBe(3)
    expect(result.packages).toBe(4)
    expect(result.text).toContain(
      `packages ['@aws-sdk/client-s3', 'lodash', 'oldpkg', 'pg']`,
    )
    expect(result.text).toContain('vendor = component')

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // Every element-to-package crossing is a drift edge; the resolve tier is
    // quiet, so no unmatched or ambiguous package rule fires.
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(3)
    expect(ruleIds(gate.findings)).toEqual(['drift-relationship'])
  })

  test('files directly in a scan root get one catch-all element', HEAVY, async () => {
    const config = configFor('external')
    const result = await draft(config)

    // src/ holds only root-level files: one catch-all element claiming the
    // root, plus the package stub.
    expect(result.elements).toBe(2)
    expect(result.text).toContain(`src = component 'src'`)
    expect(result.text).toContain(`sources 'src/**'`)
    expect(result.text).toContain(`packages ['amqplib', 'stripe']`)

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // The fixture's broken import stays a warning; it is not the draft's to fix.
    expect(ruleIds(gate.findings)).toEqual(['drift-relationship', 'unresolved-import'])
  })

  test('--no-drift emits plain relationships and still gates green', HEAVY, async () => {
    const config = configFor('drift')
    const result = await draft(config, { drift: false })

    expect(result.text).not.toContain('#drift')
    expect(result.text).not.toContain('tag drift')
    expect(result.text).toContain('app.legacy -> app.core // 2 dependencies')

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    // Plain relationships mean no burn-down: the debt is blessed, not counted.
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toEqual([])
  })

  test('refuses to write where any model file already exists', HEAVY, async () => {
    const config = configFor('drift')
    fs.writeFileSync(path.join(config.modelDir, 'authored.c4'), '// authored\n')

    const result = await draft(config)

    expect(result.written).toBeUndefined()
    expect(result.refusal).toContain('authored.c4')
    expect(result.refusal).toContain('never overwrites')
    // The draft is still produced for stdout; the authored file is untouched
    // and nothing new appeared beside it.
    expect(result.text).toContain('app.legacy -> app.core')
    expect(fs.readFileSync(path.join(config.modelDir, 'authored.c4'), 'utf8')).toBe('// authored\n')
    expect(fs.readdirSync(config.modelDir)).toEqual(['authored.c4'])
  })

  test('consumes observations from any configured scan provider', HEAVY, async () => {
    // A deterministic stand-in for dependency-cruiser or an agent scanner:
    // draft reads the observation contract, not TypeScript specifics.
    const observations: Observation[] = [
      { id: 'file:src/views/page.ts', kind: 'file', subject: { kind: 'file', id: 'src/views/page.ts' }, provider: 'stub' },
      { id: 'file:src/api/server.ts', kind: 'file', subject: { kind: 'file', id: 'src/api/server.ts' }, provider: 'stub' },
      {
        id: 'dep:1',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/views/page.ts' },
        target: { kind: 'file', id: 'src/api/server.ts' },
        provider: 'stub',
      },
      {
        id: 'dep:2',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/api/server.ts' },
        target: { kind: 'module', id: 'fastify' },
        provider: 'stub',
      },
      {
        id: 'dep:3',
        kind: 'dependency',
        subject: { kind: 'file', id: 'src/api/server.ts' },
        target: { kind: 'module', id: 'node:fs' },
        provider: 'stub',
      },
    ]
    const config: ResolvedConfig = {
      ...configFor('drift'),
      providers: {
        scan: [{ id: 'stub', run: async (_context: ScanContext) => observations }],
      },
    }

    const result = await draft(config)

    // `views` is a directory name LikeC4's grammar reserves; the identifier is
    // mangled while the title keeps the observed name.
    expect(result.text).toContain(`views_ = component 'views'`)
    expect(result.text).toContain(`sources 'src/views/**'`)
    expect(result.text).toContain('app.views_ -> app.api { #drift } // 1 dependency')
    // Builtins are not packages; only fastify is claimed.
    expect(result.text).toContain(`packages ['fastify']`)
    expect(result.packages).toBe(1)
    expect(result.edges).toBe(2)

    // The mangled identifier still parses and the stub-scanned gate is green.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
  })

  /** A config whose scan is the given observations, verbatim. */
  function stubConfig(observations: Observation[]): ResolvedConfig {
    return {
      ...configFor('drift'),
      providers: {
        scan: [{ id: 'stub', run: async (_context: ScanContext) => observations }],
      },
    }
  }

  function file(id: string): Observation {
    return { id: `file:${id}`, kind: 'file', subject: { kind: 'file', id }, provider: 'stub' }
  }

  function dependency(ordinal: number, from: string, to: { kind: string; id: string }): Observation {
    return {
      id: `dep:${ordinal}`,
      kind: 'dependency',
      subject: { kind: 'file', id: from },
      target: to,
      provider: 'stub',
    }
  }

  test('splits a directory where dependencies cross inside it and collapses where none do', HEAVY, async () => {
    const config = stubConfig([
      file('src/billing/wiring.ts'),
      file('src/billing/invoices/create.ts'),
      file('src/billing/payments/charge.ts'),
      file('src/reporting/deep/other.ts'),
      file('src/reporting/deep/nested/report.ts'),
      // The crossing between invoices and payments splits billing; the
      // dependency inside reporting stays under its one subdirectory, so
      // reporting collapses however deep its folders go.
      dependency(1, 'src/billing/invoices/create.ts', { kind: 'file', id: 'src/billing/payments/charge.ts' }),
      dependency(2, 'src/reporting/deep/other.ts', { kind: 'file', id: 'src/reporting/deep/nested/report.ts' }),
      dependency(3, 'src/billing/invoices/create.ts', { kind: 'file', id: 'src/reporting/deep/nested/report.ts' }),
    ])

    const result = await draft(config)

    // billing splits and keeps the catch-all claim for its direct wiring.ts;
    // longest-prefix ownership hands the subdirectories to the children.
    expect(result.text).toContain(`sources 'src/billing/**'`)
    expect(result.text).toContain(`sources 'src/billing/invoices/**'`)
    expect(result.text).toContain(`sources 'src/billing/payments/**'`)
    // reporting collapses into one element; no subdirectory element appears.
    expect(result.text).toContain(`sources 'src/reporting/**'`)
    expect(result.text).not.toContain(`sources 'src/reporting/deep/**'`)
    expect(result.elements).toBe(4)

    // Edges connect the deepest owning elements; the dependency inside the
    // collapsed reporting element is no crossing at all.
    expect(result.text).toContain('app.billing.invoices -> app.billing.payments { #drift } // 1 dependency')
    expect(result.text).toContain('app.billing.invoices -> app.reporting { #drift } // 1 dependency')
    expect(result.edges).toBe(2)

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(2)
    expect(gate.findings.filter((finding) => finding.ruleId === 'unused-drift')).toEqual([])
  })

  test('a split directory with no direct files is a pure container and gates clean', HEAVY, async () => {
    const config = stubConfig([
      file('src/billing/invoices/create.ts'),
      file('src/billing/payments/charge.ts'),
      dependency(1, 'src/billing/invoices/create.ts', { kind: 'file', id: 'src/billing/payments/charge.ts' }),
    ])

    const result = await draft(config)

    // No file sits directly in billing, so the container claims nothing and
    // carries no metadata block; the children own everything.
    expect(result.text).toContain(`billing = component 'billing'`)
    expect(result.text).not.toContain(`sources 'src/billing/**'`)
    expect(result.text).toContain(`sources 'src/billing/invoices/**'`)

    // A container with claiming children is structural, not unobserved.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(ruleIds(gate.findings)).toEqual(['drift-relationship'])
  })

  test('fragment subjects become their own elements under the containing file', HEAVY, async () => {
    const compose = 'src/stack/compose.yml'
    const config = stubConfig([
      file(compose),
      file('src/tools/deploy.ts'),
      file(`${compose}#services.web`),
      file(`${compose}#services.api`),
      // A fragment edge inside the one file, and a plain dependency on the
      // same file, which keeps resolving to the directory-derived owner.
      dependency(1, `${compose}#services.web`, { kind: 'file', id: `${compose}#services.api` }),
      dependency(2, 'src/tools/deploy.ts', { kind: 'file', id: compose }),
    ])

    const result = await draft(config)

    // One element per distinct fragment, claiming the full locator verbatim,
    // nested under a container for the file inside the directory element.
    expect(result.text).toContain(`compose_yml = component 'compose.yml'`)
    expect(result.text).toContain(`web = component 'web'`)
    expect(result.text).toContain(`sources 'src/stack/compose.yml#services.web'`)
    expect(result.text).toContain(`sources 'src/stack/compose.yml#services.api'`)
    // stack, tools, the file container, and the two fragments.
    expect(result.elements).toBe(5)

    expect(result.text).toContain(
      'app.stack.compose_yml.web -> app.stack.compose_yml.api { #drift } // 1 dependency',
    )
    expect(result.text).toContain('app.tools -> app.stack { #drift } // 1 dependency')
    expect(result.edges).toBe(2)

    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(2)
    expect(gate.findings.filter((finding) => finding.ruleId === 'unused-drift')).toEqual([])
  })

  test('dependency targets of other kinds become boundary elements', HEAVY, async () => {
    const config = stubConfig([
      file('src/api/client.ts'),
      dependency(1, 'src/api/client.ts', { kind: 'system', id: 'stripe' }),
      dependency(2, 'src/api/client.ts', { kind: 'system', id: 'stripe' }),
      dependency(3, 'src/api/client.ts', { kind: 'service', id: 'redis-cart' }),
    ])

    const result = await draft(config)

    // One description-only element per distinct kind and id, citing the kind.
    expect(result.text).toContain(`stripe = component 'stripe'`)
    expect(result.text).toContain('the scan observed this system only at the boundary')
    expect(result.text).toContain(`redis_cart = component 'redis-cart'`)
    expect(result.text).toContain('the scan observed this service only at the boundary')
    expect(result.elements).toBe(3)

    // Boundary edges stay untagged: the gate resolves nothing onto a
    // description-only element, so a drift tag would be born unused.
    expect(result.text).toContain('app.api -> app.stripe // 2 dependencies')
    expect(result.text).toContain('app.api -> app.redis_cart // 1 dependency')
    expect(result.text).not.toContain('app.api -> app.stripe { #drift }')
    expect(result.edges).toBe(2)

    // Green with only the unobserved-elements info listing the stubs.
    const gate = await runPipeline(pipelineConfig(config))
    expect(gate.modelErrors).toEqual([])
    expect(ruleIds(gate.findings)).toEqual(['unobserved-elements'])
    expect(gate.findings.every((finding) => finding.severity === 'info')).toBe(true)
  })
})
