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
import { MODEL_PLACEHOLDER_MARKER } from '../src/init.ts'
import { runPipeline } from '../src/pipeline.ts'
import { architectureRules } from '../src/providers/architecture-rules.ts'
import { sourceRoot } from '../src/providers/source-root.ts'
import { typescriptImports } from '../src/providers/typescript-imports.ts'
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
    scan: [typescriptImports({ tsconfig: path.join(root, 'tsconfig.json'), roots: ['src'] })],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

/**
 * The attestation a real scanner always emits. Draft derives its structure
 * from `scan-root` observations, so a stub scan must attest like one.
 */
const SCAN_ROOT: Observation = {
  id: 'scan-root:src',
  kind: 'scan-root',
  subject: { kind: 'directory', id: 'src' },
  provider: 'stub',
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
    const gate = await runPipeline(config)
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

    const gate = await runPipeline(config)
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

    const gate = await runPipeline(config)
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

    const gate = await runPipeline(config)
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
      scan: [{ id: 'stub', run: async (_context: ScanContext) => [SCAN_ROOT, ...observations] }],
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
    const gate = await runPipeline(config)
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
  })

  /** A config whose scan is the given observations, plus the root attestation. */
  function stubConfig(observations: Observation[]): ResolvedConfig {
    return {
      ...configFor('drift'),
      scan: [{ id: 'stub', run: async (_context: ScanContext) => [SCAN_ROOT, ...observations] }],
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

    const gate = await runPipeline(config)
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
    expect(gate.findings.filter((finding) => finding.ruleId === 'drift-relationship')).toHaveLength(2)
    expect(gate.findings.filter((finding) => finding.ruleId === 'unused-drift')).toEqual([])
  })

  test('a hub-and-spoke package splits for structure that only exists deeper down', HEAVY, async () => {
    // The real-repository shape that motivated the recursion: one top package
    // whose subpackages never import each other, only the package's direct
    // hub files. The top level has no sibling crossing of its own, but a
    // subpackage below it holds the whole observed architecture, and a
    // one-level check would collapse everything into a single blob element.
    const config = stubConfig([
      file('src/catalog/domain.ts'),
      file('src/catalog/web/render.ts'),
      file('src/catalog/inventory/api/routes.ts'),
      file('src/catalog/inventory/pricing/runs.ts'),
      // Spokes to the hub: parent-child, never a sibling crossing.
      dependency(1, 'src/catalog/web/render.ts', { kind: 'file', id: 'src/catalog/domain.ts' }),
      dependency(2, 'src/catalog/inventory/api/routes.ts', { kind: 'file', id: 'src/catalog/domain.ts' }),
      // The one sibling crossing, two levels down inside inventory.
      dependency(3, 'src/catalog/inventory/api/routes.ts', { kind: 'file', id: 'src/catalog/inventory/pricing/runs.ts' }),
    ])

    const result = await draft(config)

    // catalog splits (keeping the catch-all claim for its direct domain.ts),
    // and so does inventory below it; web holds no deeper structure and collapses.
    expect(result.text).toContain(`sources 'src/catalog/**'`)
    expect(result.text).toContain(`sources 'src/catalog/web/**'`)
    expect(result.text).toContain(`sources 'src/catalog/inventory/api/**'`)
    expect(result.text).toContain(`sources 'src/catalog/inventory/pricing/**'`)
    // The deep crossing is the drafted edge; the hub spokes are parent-child
    // and declare nothing.
    expect(result.text).toContain('app.catalog.inventory.api -> app.catalog.inventory.pricing { #drift } // 1 dependency')
    expect(result.edges).toBe(1)

    const gate = await runPipeline(config)
    expect(gate.modelErrors).toEqual([])
    expect(errors(gate.findings)).toEqual([])
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
    const gate = await runPipeline(config)
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

    const gate = await runPipeline(config)
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
    const gate = await runPipeline(config)
    expect(gate.modelErrors).toEqual([])
    expect(ruleIds(gate.findings)).toEqual(['unobserved-elements'])
    expect(gate.findings.every((finding) => finding.severity === 'info')).toBe(true)
  })

  describe('the describe pass', () => {
    /** The composite scenario: a split directory, a vendor stub, a boundary element. */
    function describeConfig(): ResolvedConfig {
      return stubConfig([
        file('src/billing/wiring.ts'),
        file('src/billing/invoices/create.ts'),
        file('src/billing/payments/charge.ts'),
        dependency(1, 'src/billing/invoices/create.ts', { kind: 'file', id: 'src/billing/payments/charge.ts' }),
        dependency(2, 'src/billing/invoices/create.ts', { kind: 'module', id: 'stripe-js' }),
        dependency(3, 'src/billing/invoices/create.ts', { kind: 'system', id: 'stripe' }),
      ])
    }

    test('proposed descriptions land on eligible elements; an abstention keeps the TODO', HEAVY, async () => {
      const config = describeConfig()
      const offered: import('../src/draft.ts').DraftElementFacts[] = []
      const messages: string[] = []

      const result = await draft(config, {
        onProgress: (message) => void messages.push(message),
        describe: async (element) => {
          offered.push(element)
          if (element.path === 'billing.invoices') return '  Creates and stores invoices.\n'
          return undefined
        },
      })

      // Eligible: the three claiming elements, each with owned observed files.
      // The vendor stub and the boundary element were never offered.
      expect(offered.map((element) => element.path).sort()).toEqual([
        'billing',
        'billing.invoices',
        'billing.payments',
      ])
      const invoices = offered.find((element) => element.path === 'billing.invoices')
      expect(invoices).toEqual({
        name: 'invoices',
        path: 'billing.invoices',
        declared: 'src/billing/invoices/**',
        ownedFiles: ['src/billing/invoices/create.ts'],
      })

      // The proposal replaced the TODO, trimmed; the rest kept theirs, and the
      // structure (claims, edges) is untouched.
      expect(result.describeAttempted).toBe(3)
      expect(result.described).toBe(1)
      expect(result.text).toContain(`description 'Creates and stores invoices.'`)
      expect(result.text).toContain(`sources 'src/billing/invoices/**'`)
      expect(result.text.match(/TODO: what is this component responsible for\?/g)).toHaveLength(2)
      expect(result.text).toContain('TODO: split these packages')
      expect(result.text).toContain('only at the boundary')

      // The narration matches the run: a count, then one line per element.
      expect(messages).toContain('describe: 3 elements')
      expect(messages).toContain('describe: app.billing.invoices...')
      expect(messages).toContainEqual(
        expect.stringMatching(/^describe: app\.billing\.invoices done, \d+\.\ds$/),
      )
      expect(messages).toContainEqual(
        expect.stringMatching(/^describe: app\.billing kept the TODO, \d+\.\ds$/),
      )

      // A described draft still gates green: describe edits description text only.
      const gate = await runPipeline(config)
      expect(gate.modelErrors).toEqual([])
      expect(errors(gate.findings)).toEqual([])
    })

    test('fragment elements are eligible, with the containing file as their owned file', HEAVY, async () => {
      const compose = 'src/stack/compose.yml'
      const config = stubConfig([
        file(compose),
        file(`${compose}#services.web`),
        file(`${compose}#services.api`),
        dependency(1, `${compose}#services.web`, { kind: 'file', id: `${compose}#services.api` }),
      ])
      const offered: string[] = []

      const result = await draft(config, {
        describe: async (element) => {
          offered.push(element.path)
          expect(element.ownedFiles).toEqual([compose])
          if (element.declared.endsWith('#services.web')) return 'Serves the web UI.'
          return undefined
        },
      })

      // The stack directory owns the plain compose observation; each fragment
      // owns its locator, stripped to the readable file. The claimless
      // file-container element is never offered.
      expect(offered.sort()).toEqual([
        'stack',
        'stack.compose_yml.api',
        'stack.compose_yml.web',
      ])
      expect(result.describeAttempted).toBe(3)
      expect(result.described).toBe(1)
      expect(result.text).toContain(`description 'Serves the web UI.'`)
      expect(result.text).toContain(`sources 'src/stack/compose.yml#services.web'`)
    })

    test('without a describe callback the counts are zero and every description is the TODO', HEAVY, async () => {
      const result = await draft(describeConfig())

      expect(result.describeAttempted).toBe(0)
      expect(result.described).toBe(0)
      expect(result.text.match(/TODO: what is this component responsible for\?/g)).toHaveLength(3)
    })

    // The transport-failure contract: a callback that cannot run is not a
    // callback that declined, so the draft fails and leaves nothing behind.
    test('a thrown callback aborts on the first element and writes nothing', HEAVY, async () => {
      const config = describeConfig()
      const offered: string[] = []

      await expect(
        draft(config, {
          describe: async (element) => {
            offered.push(element.path)
            throw new Error('claude-cli/sonnet could not run: not logged in')
          },
        }),
      ).rejects.toThrow(/describe aborted at app\.billing.*not logged in.*No model was written/s)

      // One call, not one per element: N more calls against a dead CLI are N
      // more pointless waits.
      expect(offered).toHaveLength(1)
      expect(fs.readdirSync(config.modelDir)).toEqual([])
    })

    // Refusal mode costs nothing: the descriptions would have been paid for,
    // printed to scrollback, and discarded.
    test('a draft that will refuse to write skips the describe pass entirely', HEAVY, async () => {
      const config = describeConfig()
      fs.writeFileSync(path.join(config.modelDir, 'authored.c4'), '// authored\n')
      let calls = 0

      const result = await draft(config, {
        describe: async () => {
          calls += 1
          return 'Never asked for.'
        },
      })

      expect(calls).toBe(0)
      expect(result.describeAttempted).toBe(0)
      expect(result.described).toBe(0)
      expect(result.written).toBeUndefined()
      // The note says why, so a skipped pass is never mistaken for a free one.
      expect(result.refusal).toContain('never overwrites')
      expect(result.refusal).toContain('The describe pass was skipped')
    })
  })

  describe("init's placeholder", () => {
    /** The marker line plus the rest of init's starter model. */
    function placeholderModel(): string {
      return `${MODEL_PLACEHOLDER_MARKER}\nspecification {\n  element system\n}\n\nmodel {\n  app = system 'App'\n}\n`
    }

    test('a model directory holding only the untouched placeholder is drafted over', HEAVY, async () => {
      const config = configFor('drift')
      const placeholder = path.join(config.modelDir, 'model.c4')
      fs.writeFileSync(placeholder, placeholderModel())

      const result = await draft(config)

      expect(result.refusal).toBeUndefined()
      expect(result.written).toBe(placeholder)
      expect(fs.readdirSync(config.modelDir)).toEqual(['model.c4'])
      // The draft is the user's model from here on, so it carries no marker of
      // its own: a second draft over it would be overwriting authored work.
      expect(result.text).not.toContain(MODEL_PLACEHOLDER_MARKER)
      expect(result.text).not.toContain('fitc4 init placeholder')
      expect(fs.readFileSync(placeholder, 'utf8')).toBe(result.text)
      // Reported, because "created" for the one case where this tool
      // overwrites a file is a lie to the reader most likely to wonder:
      // someone who ran init a minute ago.
      expect(result.replacedPlaceholder).toBe(true)
    })

    test('a draft into an empty model directory reports no replacement', HEAVY, async () => {
      // configFor's modelDir is a fresh scratch directory, so this is the
      // ordinary first draft: a creation, and the flag must stay absent.
      const result = await draft(configFor('drift'))

      expect(result.written).toBeDefined()
      expect(result.replacedPlaceholder).toBeUndefined()
    })

    test('the placeholder is replaced in place, leaving no orphan beside a renamed one', HEAVY, async () => {
      const config = configFor('drift')
      fs.writeFileSync(path.join(config.modelDir, 'architecture.c4'), placeholderModel())

      const result = await draft(config)

      expect(result.written).toBe(path.join(config.modelDir, 'architecture.c4'))
      expect(fs.readdirSync(config.modelDir)).toEqual(['architecture.c4'])
    })

    test('an edited marker line means the file is authored now, so the draft refuses', HEAVY, async () => {
      const config = configFor('drift')
      const edited = placeholderModel().replace(
        MODEL_PLACEHOLDER_MARKER,
        `${MODEL_PLACEHOLDER_MARKER} Mine now.`,
      )
      fs.writeFileSync(path.join(config.modelDir, 'model.c4'), edited)

      const result = await draft(config)

      expect(result.written).toBeUndefined()
      expect(result.refusal).toContain('never overwrites')
      expect(fs.readFileSync(path.join(config.modelDir, 'model.c4'), 'utf8')).toBe(edited)
    })

    test('a marker anywhere but the first line does not count', HEAVY, async () => {
      const config = configFor('drift')
      const buried = `// notes\n${placeholderModel()}`
      fs.writeFileSync(path.join(config.modelDir, 'model.c4'), buried)

      const result = await draft(config)

      expect(result.written).toBeUndefined()
      expect(fs.readFileSync(path.join(config.modelDir, 'model.c4'), 'utf8')).toBe(buried)
    })

    test('a placeholder beside a second model file refuses: which one is the placeholder is not a guess', HEAVY, async () => {
      const config = configFor('drift')
      fs.writeFileSync(path.join(config.modelDir, 'model.c4'), placeholderModel())
      fs.writeFileSync(path.join(config.modelDir, 'authored.c4'), '// authored\n')

      const result = await draft(config)

      expect(result.written).toBeUndefined()
      expect(result.refusal).toContain('never overwrites')
      expect(fs.readFileSync(path.join(config.modelDir, 'model.c4'), 'utf8')).toBe(placeholderModel())
    })
  })
})
