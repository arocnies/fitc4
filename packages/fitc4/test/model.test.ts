import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import { findingId, namespaced, relationshipId } from '../src/ids.ts'
import {
  declaredRelationships,
  hasRelationship,
  isAncestorOf,
  isSameOrNested,
  loadModel,
  ownershipPrefixes,
  packageClaims,
  packageNameOf,
  toPackageName,
  toPrefix,
  nearestElementName,
} from '../src/model.ts'
import { ownerOf } from '../src/providers/source-root.ts'
import { fixturePath } from './helpers.ts'

describe('toPrefix', () => {
  test.each([
    ['src/core/**', 'src/core/'],
    ['src/core', 'src/core/'],
    ['src/core/', 'src/core/'],
    ['./src/core/**', 'src/core/'],
    ['/src/core/**', 'src/core/'],
    ['src\\core\\**', 'src/core/'],
    ['  src/core/**  ', 'src/core/'],
  ])('normalizes %j to %j', (declared, prefix) => {
    expect(toPrefix(declared)).toEqual({ prefix })
  })

  // A prefix the matcher cannot honour must be rejected loudly. Silently
  // producing a prefix that matches nothing is what makes the gate fail open.
  test.each([
    ['src/core/*', 'wildcard'],
    ['src/**/*.ts', 'wildcard'],
    ['src/*/core/**', 'wildcard'],
    ['src/core/health.ts', 'file'],
    ['**', 'whole repository'],
    ['/**', 'whole repository'],
    ['', 'empty'],
  ])('rejects %j', (declared, hint) => {
    const result = toPrefix(declared)
    expect(result).toHaveProperty('reason')
    expect('reason' in result ? result.reason : '').toContain(hint)
  })

  // A fragment claim owns a region inside one file; only its path half is
  // normalized, the locator rides along opaquely.
  test.each([
    ['stack/compose.yml#services.web', 'stack/compose.yml#services.web'],
    ['./stack/compose.yml#services.web', 'stack/compose.yml#services.web'],
    ['stack\\compose.yml#services.web', 'stack/compose.yml#services.web'],
    ['  stack/compose.yml#services.web  ', 'stack/compose.yml#services.web'],
  ])('normalizes the fragment claim %j to %j', (declared, prefix) => {
    expect(toPrefix(declared)).toEqual({ prefix })
  })

  test.each([
    ['#services.web', 'fragment without a file'],
    ['stack/compose.yml#', 'empty fragment'],
    ['stack/*.yml#services.web', 'wildcard'],
    ['stack/compose.yml#services.*', 'wildcard'],
  ])('rejects the fragment claim %j', (declared, hint) => {
    const result = toPrefix(declared)
    expect(result).toHaveProperty('reason')
    expect('reason' in result ? result.reason : '').toContain(hint)
  })
})

describe('ownership prefixes', () => {
  test('strips the glob suffix and normalizes to a directory prefix', async () => {
    const { model } = await loadModel(fixturePath('ok'))
    const { prefixes } = ownershipPrefixes(model)

    expect(prefixes).toContainEqual({
      elementId: 'fixture.app.core',
      prefix: 'src/core/',
      declared: 'src/core/**',
    })
  })

  test('an element with no sources contributes no prefix', async () => {
    const { model } = await loadModel(fixturePath('ok'))
    const { prefixes } = ownershipPrefixes(model)

    // The system and container elements are deliberately unowned.
    expect(prefixes.map((entry) => entry.elementId)).toEqual([
      'fixture.app.core',
      'fixture.app.interface',
    ])
  })

  test('an unsupported source is rejected rather than silently ignored', async () => {
    const { model } = await loadModel(fixturePath('bad-sources'))
    const { rejected } = ownershipPrefixes(model)

    expect(rejected.map((entry) => entry.elementId)).toEqual(['fixture.wild'])
  })
})

describe('ownerOf', () => {
  const prefixes = [
    { elementId: 'app.core', prefix: 'src/core/', declared: 'src/core/**' },
    { elementId: 'app.core.inner', prefix: 'src/core/inner/', declared: 'src/core/inner/**' },
    { elementId: 'app.a', prefix: 'src/shared/', declared: 'src/shared/**' },
    { elementId: 'app.b', prefix: 'src/shared/', declared: 'src/shared/**' },
  ]

  test('resolves a file to its owning element', () => {
    expect(ownerOf('src/core/health.ts', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.core',
    })
  })

  test('longest prefix wins, so a nested element beats its parent', () => {
    expect(ownerOf('src/core/inner/deep.ts', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.core.inner',
    })
  })

  test('an equal-length tie is ambiguous', () => {
    expect(ownerOf('src/shared/util.ts', prefixes)).toEqual({
      status: 'ambiguous',
      candidates: ['app.a', 'app.b'],
    })
  })

  test('a file under no prefix is unresolved', () => {
    expect(ownerOf('src/orphan/thing.ts', prefixes)).toEqual({ status: 'unresolved' })
  })

  // The trailing slash on every prefix is what stops `src/` claiming
  // `src-legacy/`. Locked in so a future simplification cannot drop it.
  test('a sibling directory sharing a name prefix is not claimed', () => {
    expect(ownerOf('src-legacy/old.ts', [prefixes[0] as (typeof prefixes)[number]])).toEqual({
      status: 'unresolved',
    })
  })
})

describe('ownerOf with fragment claims', () => {
  const declared = 'stack/compose.yml#services.web'
  const prefixes = [
    { elementId: 'app.web', prefix: 'stack/compose.yml#services.web', declared },
    { elementId: 'app.stack', prefix: 'stack/', declared: 'stack/**' },
  ]

  test('resolves a fragment subject to the claiming element', () => {
    expect(ownerOf('stack/compose.yml#services.web', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.web',
    })
  })

  test('a locator nested at a dot boundary is still claimed', () => {
    expect(ownerOf('stack/compose.yml#services.web.environment', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.web',
    })
  })

  // The dot boundary plays the trailing slash's role: without it the claim
  // `#services.web` would also own `#services.web2`.
  test('a sibling locator sharing a name prefix falls back to the directory claim', () => {
    expect(ownerOf('stack/compose.yml#services.web2', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.stack',
    })
  })

  test('a plain file path is never owned by a fragment claim', () => {
    expect(ownerOf('stack/compose.yml', prefixes)).toEqual({
      status: 'resolved',
      elementId: 'app.stack',
    })
  })

  test('an unclaimed fragment subject with no directory fallback is unresolved', () => {
    expect(
      ownerOf('stack/compose.yml#services.db', [
        prefixes[0] as (typeof prefixes)[number],
      ]),
    ).toEqual({ status: 'unresolved' })
  })
})

describe('package name derivation', () => {
  test.each([
    ['pg', 'pg'],
    ['pg/promises', 'pg'],
    ['@aws-sdk/client-s3', '@aws-sdk/client-s3'],
    ['@aws-sdk/client-s3/commands', '@aws-sdk/client-s3'],
    ['node:path', 'node:path'],
  ])('derives %j from %j', (specifier, name) => {
    expect(packageNameOf(specifier)).toBe(name)
  })
})

describe('toPackageName', () => {
  test.each([
    ['pg', 'pg'],
    ['@aws-sdk/client-s3', '@aws-sdk/client-s3'],
    ['  pg  ', 'pg'],
  ])('accepts %j as %j', (declared, name) => {
    expect(toPackageName(declared)).toEqual({ name })
  })

  // A claim that is not an exact package name would silently gate nothing —
  // the fail-open the loud rejection exists to prevent.
  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['pg client', 'whitespace'],
    ['pg/promises', "claim the package 'pg'"],
    ['@aws-sdk/client-s3/commands', "claim the package '@aws-sdk/client-s3'"],
    ['pg/', 'subpath'],
    ['@scope', 'scope without a package'],
    ['./pg', 'path'],
    ['/pg', 'path'],
  ])('rejects %j', (declared, hint) => {
    const result = toPackageName(declared)
    expect(result).toHaveProperty('reason')
    expect('reason' in result ? result.reason : '').toContain(hint)
  })
})

describe('package claims', () => {
  test('claims carry the claiming element and the exact name', async () => {
    const { model } = await loadModel(fixturePath('packages'))
    const { claims, rejected } = packageClaims(model)

    expect(rejected).toEqual([])
    expect(claims.map((claim) => `${claim.elementId} ${claim.name}`).sort()).toEqual([
      'fixture.cloud @aws-sdk/client-s3',
      'fixture.infra pg',
      'fixture.oldstore oldpkg',
    ])
  })

  test('an invalid claim is rejected rather than silently ignored', async () => {
    const { model } = await loadModel(fixturePath('bad-packages'))
    const { rejected } = packageClaims(model)

    expect(rejected.map((entry) => entry.elementId).sort()).toEqual([
      'fixture.blank',
      'fixture.deep',
    ])
  })
})

describe('relationship tags', () => {
  test('declared relationships record their tags', async () => {
    const { model } = await loadModel(fixturePath('drift'))
    const { byId } = declaredRelationships(model)

    expect(byId.get('fixture.legacy::_::fixture.core')?.tags).toEqual(['drift'])
    expect(byId.get('fixture.interface::_::fixture.core')?.tags).toEqual([])
  })
})

describe('containment', () => {
  test('recognizes ancestry from the FQN', () => {
    expect(isAncestorOf('app', 'app.core')).toBe(true)
    expect(isAncestorOf('app.core', 'app')).toBe(false)
    expect(isAncestorOf('app', 'apple.core')).toBe(false)
  })

  test('same-or-nested is symmetric', () => {
    expect(isSameOrNested('app.core', 'app.core')).toBe(true)
    expect(isSameOrNested('app', 'app.core')).toBe(true)
    expect(isSameOrNested('app.core', 'app')).toBe(true)
    expect(isSameOrNested('app.core', 'web.ui')).toBe(false)
  })

  test('a relationship between parents covers traffic between their descendants', async () => {
    const { model } = await loadModel(fixturePath('nested'))
    const declared = declaredRelationships(model)

    expect(hasRelationship(declared, 'fixture.web.ui', 'fixture.app.core')?.id).toBe(
      'fixture.web::_::fixture.app',
    )
    // Still directional.
    expect(hasRelationship(declared, 'fixture.app.core', 'fixture.web.ui')).toBeUndefined()
  })
})

describe('stable identifiers', () => {
  // A typed relationship still embeds its kind, so a model that later adopts
  // relationship kinds keeps distinct identities per kind.
  test('a relationship id is derived from author-controlled names', () => {
    expect(relationshipId('app.iface', 'app.core', 'imports')).toBe('app.iface::imports::app.core')
  })

  // Plain `a -> b` is the idiomatic LikeC4 default and carries no kind.
  test('an untyped relationship still gets a stable id', () => {
    expect(relationshipId('app.iface', 'app.core', null)).toBe('app.iface::_::app.core')
  })

  test('the model never surfaces a LikeC4 hash as a relationship id', async () => {
    const { model } = await loadModel(fixturePath('ok'))
    const { byId } = declaredRelationships(model)

    expect([...byId.keys()]).toEqual(['fixture.app.interface::_::fixture.app.core'])
  })

  test('finding ids carry provider, rule, and subject', () => {
    expect(findingId('architecture-rules', 'unmapped-source', 'src/x.ts')).toBe(
      'architecture-rules/unmapped-source/src/x.ts',
    )
  })

  test('namespacing is idempotent', () => {
    expect(namespaced('p', 'file:x')).toBe('p/file:x')
    expect(namespaced('p', 'p/file:x')).toBe('p/file:x')
  })
})

describe('native model validation', () => {
  test('a valid workspace reports no errors', async () => {
    const { errors } = await loadModel(fixturePath('ok'))
    expect(errors).toEqual([])
  })

  // A deleted model.c4, a wrong path, or an over-broad exclude would otherwise
  // yield zero ownership prefixes, no errors, and a green build.
  test('a workspace with no model is an error, not an empty pass', async () => {
    const { errors } = await loadModel(fixturePath('no-model'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('no LikeC4 elements')
  })
})

/**
 * A raw NUL byte in a source file makes the whole file read as binary to
 * `grep`, `git grep`, and every tool built on them, which silently drops it
 * out of codebase-wide searches. Two files used NUL as a map-key separator,
 * written as the literal byte rather than the `\0` escape, and both were
 * invisible to search until this was noticed. The escape compiles to the same
 * byte at runtime, so nothing about the behavior depends on writing it raw.
 */
describe('source files stay searchable', () => {
  test('no tracked source file embeds a raw NUL byte', () => {
    const root = path.resolve(import.meta.dirname, '..')
    const offenders: string[] = []

    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue
        }
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|mts|js|mjs|c4|md|json)$/.test(entry.name)) continue
        if (fs.readFileSync(full).includes(0)) {
          offenders.push(path.relative(root, full))
        }
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })
})

describe('nearestElementName', () => {
  const index = {
    exact: new Map<string, string[]>(),
    normalized: new Map([
      ['redis', ['boutique.redis']],
      ['boutiqueredis', ['boutique.redis']],
      ['cartservice', ['boutique.cartservice']],
      ['boutiquecartservice', ['boutique.cartservice']],
      ['db', ['fixture.db']],
    ]),
  }

  test('containment finds the element inside a longer real-world name', () => {
    expect(nearestElementName('redis-cart', index)).toBe('boutique.redis')
  })

  test('a small typo finds the element by edit distance', () => {
    expect(nearestElementName('cartservise', index)).toBe('boutique.cartservice')
  })

  test('a name that already maps is not a near miss', () => {
    expect(nearestElementName('redis', index)).toBeUndefined()
  })

  test('a short name cannot claim containment: db-config is not db', () => {
    expect(nearestElementName('db-config', index)).toBeUndefined()
  })

  test('two elements matching equally is silence, not a coin flip', () => {
    const ambiguous = {
      exact: new Map<string, string[]>(),
      normalized: new Map([
        ['apigateway', ['shop.apiGateway']],
        ['edgegateway', ['shop.edgeGateway']],
      ]),
    }
    // 'gateway' sits inside both names; naming either would be a guess.
    expect(nearestElementName('gateway', ambiguous)).toBeUndefined()
  })
})
