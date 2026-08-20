import { beforeAll, describe, expect, test } from 'vitest'

import { loadModel, type LikeC4Model } from '../src/model.ts'
import type { PipelineResult } from '../src/pipeline.ts'
import { renderReport } from '../src/report.ts'
import type { Finding } from '../src/types.ts'
import { viewerLink, viewIdFor, withViewerLinks, INDEX_VIEW_ID } from '../src/viewer.ts'
import { fixturePath, runFixture } from './helpers.ts'

const BASE = 'https://acme.github.io/arch'

function finding(partial: Partial<Finding>): Finding {
  return {
    id: 'test/finding',
    ruleId: 'test-rule',
    severity: 'error',
    description: 'test',
    provider: 'test',
    ...partial,
  }
}

// The route shape comes from the installed likec4 app bundle: the TanStack
// route `/view/$viewId` with `trailingSlash: "always"`, served from the
// fragment when built with `--use-hash-history`.
describe('viewerLink', () => {
  test.each([
    [BASE, `${BASE}/view/index/`],
    [`${BASE}/`, `${BASE}/view/index/`],
    [`${BASE}//`, `${BASE}/view/index/`],
    [`${BASE}/#`, `${BASE}/#/view/index/`],
    [`${BASE}/#/`, `${BASE}/#/view/index/`],
    [`${BASE}#/`, `${BASE}/#/view/index/`],
    [`${BASE}#`, `${BASE}/#/view/index/`],
  ])('base %j links to %j', (base, expected) => {
    expect(viewerLink(base, 'index')).toBe(expected)
  })

  test('escapes a view id that is not URL-safe', () => {
    expect(viewerLink(BASE, 'my view')).toBe(`${BASE}/view/my%20view/`)
  })
})

describe('viewIdFor', () => {
  // One shared load: the fixture only exists to be asked about views.
  let loaded: Promise<LikeC4Model> | undefined
  function model(): Promise<LikeC4Model> {
    loaded ??= loadModel(fixturePath('viewer')).then(({ model, errors }) => {
      expect(errors).toEqual([])
      return model
    })
    return loaded
  }

  test('picks the smallest view containing every referenced element', async () => {
    // `appOnly` and `everything` both contain core; `appOnly` is tighter.
    const chosen = viewIdFor(
      await model(),
      finding({ subject: { kind: 'element', id: 'fixture.app.core' } }),
    )
    expect(chosen).toBe('appOnly')
  })

  test('a finding spanning two containers needs the view that shows both', async () => {
    const chosen = viewIdFor(
      await model(),
      finding({
        subject: { kind: 'element', id: 'fixture.app.core' },
        related: [{ kind: 'element', id: 'fixture.web.ui' }],
      }),
    )
    expect(chosen).toBe('everything')
  })

  test('breaks a node-count tie by view id, deterministically', async () => {
    // `fixture.app` appears in both `index` and `appOnly`, three nodes each.
    const chosen = viewIdFor(
      await model(),
      finding({ subject: { kind: 'element', id: 'fixture.app' } }),
    )
    expect(chosen).toBe('appOnly')
  })

  test('a finding with no element refs falls back to the index view', async () => {
    const chosen = viewIdFor(await model(), finding({ subject: { kind: 'file', id: 'src/x.ts' } }))
    expect(chosen).toBe(INDEX_VIEW_ID)
  })

  test('an element no view shows falls back to the index view', async () => {
    const chosen = viewIdFor(
      await model(),
      finding({ subject: { kind: 'element', id: 'fixture.ghost' } }),
    )
    expect(chosen).toBe(INDEX_VIEW_ID)
  })

  test('withViewerLinks keeps a link a provider already set', async () => {
    const preset = finding({ link: 'https://elsewhere.example/x' })
    const [linked] = withViewerLinks([preset], await model(), BASE)
    expect(linked?.link).toBe('https://elsewhere.example/x')
  })
})

describe('viewer links through the pipeline', () => {
  // One run per configuration, shared across the assertions.
  let linked: PipelineResult
  let unlinked: PipelineResult
  beforeAll(async () => {
    linked = await runFixture('violations', { viewerBaseUrl: BASE })
    unlinked = await runFixture('violations')
  })

  test('with viewerBaseUrl set, every finding carries a link and the result echoes the base', () => {
    expect(linked.viewerBaseUrl).toBe(BASE)
    expect(linked.findings.length).toBeGreaterThan(0)
    for (const item of linked.findings) {
      // The violations fixture declares only the index view.
      expect(item.link).toBe(`${BASE}/view/index/`)
    }
  })

  test('links survive the JSON round trip --json performs', () => {
    const parsed = JSON.parse(JSON.stringify(linked)) as PipelineResult

    expect(parsed.viewerBaseUrl).toBe(BASE)
    expect(parsed.findings[0]?.link).toBe(`${BASE}/view/index/`)
  })

  test('without viewerBaseUrl nothing changes', () => {
    expect('viewerBaseUrl' in unlinked).toBe(false)
    expect(unlinked.findings.every((item) => item.link === undefined)).toBe(true)
    expect(renderReport(unlinked).text).not.toContain('viewer:')
  })

  test('the text report stays quiet: one footer line, no URL per finding', () => {
    const text = renderReport(linked).text

    expect(text.split('\n').filter((line) => line.includes(BASE))).toEqual([`viewer: ${BASE}`])
  })
})
