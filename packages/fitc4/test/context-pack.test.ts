/**
 * Unit tests for the shared context-pack module: graph building from the
 * inputs a provider already receives, neighborhood and element-fact
 * rendering, the code-first excerpt skip, and the budget assembler's
 * announce-everything contract. Models come from fixtures via `loadModel`;
 * observations and associations are synthetic — no scan, no agent, no I/O
 * beyond the model load and excerpt reads.
 */

import { describe, expect, test } from 'vitest'

import {
  assemblePack,
  buildGraph,
  codeFirstExcerpt,
  elementPack,
  fencedExcerpt,
  fileNeighborhood,
  PACK_HEADER,
} from '../src/agent/context-pack.ts'
import { loadModel } from '../src/model.ts'
import type { Association, LikeC4Model, Observation } from '../src/types.ts'
import { fixturePath } from './helpers.ts'

const models = new Map<string, Promise<LikeC4Model>>()
function modelOf(fixture: string): Promise<LikeC4Model> {
  if (!models.has(fixture)) {
    models.set(
      fixture,
      loadModel(fixturePath(fixture)).then(({ model, errors }) => {
        if (errors.length > 0) throw new Error(errors.join('; '))
        return model
      }),
    )
  }
  return models.get(fixture) as Promise<LikeC4Model>
}

function file(id: string): Observation {
  return { id: `file:${id}`, kind: 'file', subject: { kind: 'file', id }, provider: 't' }
}

function dependency(from: string, target: string, targetKind = 'file'): Observation {
  return {
    id: `dependency:${from}->${target}`,
    kind: 'dependency',
    subject: { kind: 'file', id: from },
    target: { kind: targetKind, id: target },
    provider: 't',
  }
}

describe('buildGraph', () => {
  test('adjacency, ownership, and owned files come from the run inputs alone', async () => {
    const model = await modelOf('violations')
    const graph = buildGraph(model, [
      file('src/core/health.ts'),
      file('src/orphan/thing.ts'),
      dependency('src/orphan/thing.ts', 'src/core/health.ts'),
      dependency('src/interface/index.ts', 'src/core/health.ts'),
    ])

    expect(graph.imports.get('src/orphan/thing.ts')).toEqual([
      { target: 'src/core/health.ts', kind: 'file' },
    ])
    expect(graph.importers.get('src/core/health.ts')).toEqual([
      'src/interface/index.ts',
      'src/orphan/thing.ts',
    ])
    expect(graph.ownerOf('src/core/health.ts')).toBe('fixture.app.core')
    expect(graph.ownerOf('src/orphan/thing.ts')).toBeUndefined()
    // Two elements claim src/shared/** — ambiguous is not an owner.
    expect(graph.ownerOf('src/shared/util.ts')).toBeUndefined()
    expect(graph.elements.get('fixture.app.core')?.ownedFiles).toEqual(['src/core/health.ts'])
  })

  test('duplicate dependency observations collapse to one adjacency edge', async () => {
    const model = await modelOf('violations')
    const graph = buildGraph(model, [
      { ...dependency('src/a.ts', 'src/core/health.ts'), id: 'first' },
      { ...dependency('src/a.ts', 'src/core/health.ts'), id: 'second' },
    ])

    expect(graph.imports.get('src/a.ts')).toHaveLength(1)
  })

  test('package claims become claimants', async () => {
    const model = await modelOf('packages')
    const graph = buildGraph(model, [])

    expect(graph.claimants.get('pg')).toBeDefined()
    expect(graph.claimants.get('lodash')).toBeUndefined()
  })

  test('resolved associations contribute observed element edges and refined ownership', async () => {
    const model = await modelOf('violations')
    const observations = [
      file('src/orphan/thing.ts'),
      dependency('src/interface/index.ts', 'src/core/health.ts'),
    ]
    const associations: Association[] = [
      {
        id: 'a1',
        observationId: 'dependency:src/interface/index.ts->src/core/health.ts',
        status: 'resolved',
        source: { kind: 'element', id: 'fixture.app.interface' },
        target: { kind: 'element', id: 'fixture.app.core' },
        provider: 't',
      },
      // An agent resolver mapped the orphan onto an element no prefix owns.
      {
        id: 'a2',
        observationId: 'file:src/orphan/thing.ts',
        status: 'resolved',
        source: { kind: 'element', id: 'fixture.app.extra' },
        provider: 't',
      },
    ]

    const graph = buildGraph(model, observations, associations)

    expect(graph.elements.get('fixture.app.interface')?.observed).toEqual([
      { sourceId: 'fixture.app.interface', targetId: 'fixture.app.core', count: 1 },
    ])
    expect(graph.elements.get('fixture.app.extra')?.ownedFiles).toContain('src/orphan/thing.ts')
  })
})

describe('fileNeighborhood', () => {
  test('annotates each neighbor with its owner, and modules with their claim', async () => {
    const model = await modelOf('packages')
    // The packages fixture: fixture.infra claims pg and owns src/infra/**.
    const graph = buildGraph(model, [
      dependency('src/app/index.ts', 'pg/promises', 'module'),
      dependency('src/app/index.ts', 'lodash', 'module'),
      dependency('src/app/index.ts', 'src/orphan.ts'),
      dependency('src/infra/db.ts', 'src/app/index.ts'),
    ])

    const neighborhood = fileNeighborhood(graph, 'src/app/index.ts')
    expect(neighborhood).toContain('- imports module lodash (unclaimed)')
    expect(neighborhood).toContain('- imports module pg/promises (claimed by fixture.infra)')
    expect(neighborhood).toContain('- imports src/orphan.ts (unowned)')
    expect(neighborhood).toContain('- imported by src/infra/db.ts (owned by fixture.infra)')
  })

  test('a file with no observed edges says so instead of vanishing', async () => {
    const model = await modelOf('violations')
    const graph = buildGraph(model, [])

    expect(fileNeighborhood(graph, 'src/orphan/thing.ts')).toBe(
      '- no observed imports or importers',
    )
  })
})

describe('elementPack', () => {
  test('carries description, declared relationships, observed edges, and all owned files', async () => {
    const model = await modelOf('external')
    const graph = buildGraph(
      model,
      [file('src/index.ts'), file('src/util.ts'), dependency('src/index.ts', 'stripe', 'module')],
      [
        {
          id: 'a1',
          observationId: 'dependency:src/index.ts->stripe',
          status: 'resolved',
          source: { kind: 'element', id: 'demo.app.core' },
          target: { kind: 'element', id: 'demo.external.payments' },
          provider: 't',
        },
      ],
    )

    const pack = elementPack(graph, 'demo.app.core', { excerpted: ['src/index.ts'] })
    expect(pack).toContain("### Element facts: demo.app.core ('Core')")
    expect(pack).toContain('- demo.app.core -> demo.external.queue') // declared
    expect(pack).toContain('- demo.app.core -> demo.external.payments (1 dependency)') // observed
    expect(pack).toContain('Owned files (2 total, 1 excerpted below):')
    expect(pack).toContain('- src/index.ts (excerpted)')
    expect(pack).toContain('- src/util.ts (not excerpted)')
  })

  test('an element that is not in the model fails loudly', async () => {
    const graph = buildGraph(await modelOf('external'), [])
    expect(() => elementPack(graph, 'demo.nope')).toThrow('not an element in the model')
  })
})

describe('codeFirstExcerpt', () => {
  test('skips leading line comments, block comments, and blanks, and counts them', () => {
    const content = ['/**', ' * Long module doc.', ' */', '', '// setup', 'const a = 1', ''].join(
      '\n',
    )
    const excerpt = codeFirstExcerpt(content, 1000)

    expect(excerpt.text.startsWith('const a = 1')).toBe(true)
    expect(excerpt.skippedLines).toBe(5)
    expect(excerpt.droppedChars).toBe(0)
  })

  test('a file that is nothing but comments keeps its head, unannounced', () => {
    const content = '// only a comment\n// and another'
    const excerpt = codeFirstExcerpt(content, 1000)

    expect(excerpt.text).toBe(content)
    expect(excerpt.skippedLines).toBe(0)
  })

  test('hash lines are not treated as comments — markdown and YAML survive', () => {
    const excerpt = codeFirstExcerpt('# heading\n\nbody', 1000)
    expect(excerpt.text.startsWith('# heading')).toBe(true)
    expect(excerpt.skippedLines).toBe(0)
  })

  test('code on the block-comment close line is kept', () => {
    const excerpt = codeFirstExcerpt('/* one */ const a = 1\nconst b = 2', 1000)
    expect(excerpt.text).toContain('const a = 1')
    expect(excerpt.skippedLines).toBe(0)
  })

  test('the character cap reports exactly what it dropped', () => {
    const excerpt = codeFirstExcerpt('const a = 1\n'.repeat(100), 24)
    expect(excerpt.text.length).toBe(24)
    expect(excerpt.droppedChars).toBe(1200 - 24)
  })

  test('fencedExcerpt announces the skip and the truncation inline', () => {
    const fenced = fencedExcerpt(
      fixturePath('violations'),
      'src/core/health.ts',
      10_000,
    )
    expect(fenced).toContain('```')

    const truncated = fencedExcerpt(fixturePath('violations'), 'src/core/health.ts', 5)
    expect(truncated).toContain('more characters not shown')

    expect(fencedExcerpt(fixturePath('violations'), 'src/nope.ts', 100)).toContain('(unreadable)')
  })
})

describe('assemblePack', () => {
  test('starts with the versioned header and keeps sections in order', () => {
    const pack = assemblePack(
      [
        { header: '### One', items: ['- a', '- b'], what: 'ones' },
        { header: '### Two', items: [], what: 'twos' },
      ],
      10_000,
    )

    expect(pack.text.startsWith(`${PACK_HEADER}\n`)).toBe(true)
    expect(pack.text.indexOf('### One')).toBeLessThan(pack.text.indexOf('### Two'))
    expect(pack.text).not.toContain('NOTE:')
    expect(pack.dropped).toEqual([])
  })

  test('the byte budget drops items from the tail and announces the count', () => {
    const items = Array.from({ length: 10 }, (_, index) => `- item ${index} ${'x'.repeat(50)}`)
    const pack = assemblePack([{ header: '### Files', items, what: 'files' }], 250)

    expect(pack.text).toContain('- item 0')
    expect(pack.text).not.toContain('- item 9')
    const [drop] = pack.dropped
    expect(drop?.what).toBe('files')
    expect(drop?.count).toBeGreaterThan(0)
    expect(pack.text).toContain(`NOTE: ${drop?.count} files beyond budget not shown`)
  })

  test('a caller count cap folds into the same announcement', () => {
    const pack = assemblePack(
      [{ header: '### Files', items: ['- shown'], what: 'files', alreadyDropped: 3 }],
      10_000,
    )

    expect(pack.text).toContain('- shown')
    expect(pack.text).toContain('NOTE: 3 files beyond budget not shown')
    expect(pack.dropped).toEqual([{ what: 'files', count: 3 }])
  })

  test('headers and NOTE lines are exempt: a tiny budget still announces everything', () => {
    const pack = assemblePack(
      [{ header: '### Files', items: ['- a', '- b'], what: 'files' }],
      1,
    )

    expect(pack.text).toContain('### Files')
    expect(pack.text).toContain('NOTE: 2 files beyond budget not shown')
  })
})
