/**
 * `importScan` is the out-of-the-box scanner for repositories the TypeScript
 * scanner cannot read, so what it observes per language is pinned here file
 * by file: which imports resolve to repository files, which become claimable
 * external modules, which are the runtime's and stay silent, and which fail
 * loudly. Silent coverage loss is the core fear, same as the TypeScript
 * scanner's suite.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

import { importScan, isTestPath } from '../src/providers/import-scan.ts'
import type { Observation } from '../src/types.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** A scratch repository built from `files` (paths relative to its root). */
function scratchRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-import-scan-'))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

async function scan(
  repositoryRoot: string,
  scanRoots?: string[],
): Promise<Observation[]> {
  const provider = importScan(scanRoots === undefined ? {} : { roots: scanRoots })
  return provider.run({ repositoryRoot })
}

/** The dependency-shaped observations, as compact `from -> kind:target` strings. */
function edges(observations: Observation[]): string[] {
  return observations
    .filter((o) => o.kind === 'dependency' || o.kind === 'unresolved-dependency')
    .map((o) => {
      const marker = o.kind === 'unresolved-dependency' ? '?' : ''
      return `${o.subject?.id} ->${marker} ${o.target?.kind}:${o.target?.id}`
    })
    .sort()
}

describe('python', () => {
  test('resolves local imports, claims externals by top-level name, and skips the stdlib', async () => {
    const repo = scratchRepo({
      'src/app/__init__.py': '',
      'src/app/api/__init__.py': '',
      'src/app/api/routes.py':
        'import os\n' +
        'import yaml, httpx\n' +
        'from app.core import engine\n' +
        'from app.core.engine import run\n' +
        'from . import helpers\n' +
        'from ..store import db\n',
      'src/app/api/helpers.py': 'from __future__ import annotations\n',
      'src/app/core/__init__.py': '',
      'src/app/core/engine.py': 'from sqlalchemy.orm import Session\n',
      'src/app/store/__init__.py': '',
      'src/app/store/db.py': 'import pathlib\n',
    })

    const observations = await scan(repo, ['src'])

    expect(edges(observations)).toEqual([
      // `from app.core import engine` lands on the module part, app.core.
      'src/app/api/routes.py -> file:src/app/api/__init__.py',
      'src/app/api/routes.py -> file:src/app/core/__init__.py',
      'src/app/api/routes.py -> file:src/app/core/engine.py',
      'src/app/api/routes.py -> file:src/app/store/__init__.py',
      // External packages claim by their top-level importable name.
      'src/app/api/routes.py -> module:httpx',
      'src/app/api/routes.py -> module:yaml',
      'src/app/core/engine.py -> module:sqlalchemy',
    ])
    // os, pathlib, __future__ are the runtime's, not this architecture's.
    expect(observations.some((o) => o.target?.id.includes('os'))).toBe(false)
  })

  test('a dotted path under an existing local package is unresolved, not external', async () => {
    const repo = scratchRepo({
      'src/app/__init__.py': '',
      'src/app/main.py': 'from app.gone import missing\n',
    })
    const observations = await scan(repo, ['src'])
    expect(edges(observations)).toEqual(['src/app/main.py ->? module:app.gone'])
  })

  test('a relative import in a namespace package with no __init__ stays silent', async () => {
    const repo = scratchRepo({
      'src/pkg/a.py': 'from . import b\n',
      'src/pkg/b.py': '',
    })
    const observations = await scan(repo, ['src'])
    expect(edges(observations)).toEqual([])
  })
})

describe('javascript', () => {
  test('resolves relative specifiers across extensions, indexes, and cache busters', async () => {
    const repo = scratchRepo({
      'web/app.js':
        "import { render } from './ui/charts.js?v=3'\n" +
        "import shell from './shell'\n" +
        "import * as lib from './lib'\n" +
        "import express from 'express'\n" +
        "import fs from 'node:fs'\n" +
        "const dynamic = await import('./dynamic.js')\n" +
        "const legacy = require('./legacy.cjs')\n",
      'web/ui/charts.js': "export * from './axes.js'\n",
      'web/ui/axes.js': '',
      'web/shell.ts': "import {\n  many,\n  names,\n} from './lib'\n",
      'web/lib/index.ts': '',
      'web/dynamic.js': '',
      'web/legacy.cjs': '',
    })

    const observations = await scan(repo, ['web'])

    expect(edges(observations)).toEqual([
      'web/app.js -> file:web/dynamic.js',
      'web/app.js -> file:web/legacy.cjs',
      'web/app.js -> file:web/lib/index.ts',
      'web/app.js -> file:web/shell.ts',
      'web/app.js -> file:web/ui/charts.js',
      'web/app.js -> module:express',
      'web/shell.ts -> file:web/lib/index.ts',
      'web/ui/charts.js -> file:web/ui/axes.js',
    ])
  })

  test('an explicit .js specifier resolves to its .ts source', async () => {
    const repo = scratchRepo({
      'src/a.ts': "import { b } from './b.js'\n",
      'src/b.ts': '',
    })
    expect(edges(await scan(repo, ['src']))).toEqual(['src/a.ts -> file:src/b.ts'])
  })

  test('a relative specifier with no file behind it is unresolved', async () => {
    const repo = scratchRepo({ 'src/a.js': "import { x } from './missing'\n" })
    expect(edges(await scan(repo, ['src']))).toEqual(['src/a.js ->? module:./missing'])
  })
})

describe('go', () => {
  test('resolves module-local packages via go.mod and maps externals to required modules', async () => {
    const repo = scratchRepo({
      'go.mod':
        'module example.com/catalog\n\ngo 1.22\n\nrequire (\n' +
        '\tgithub.com/gin-gonic/gin v1.10.0\n)\n',
      'cmd/server/main.go':
        'package main\n\nimport (\n' +
        '\t"fmt"\n' +
        '\tapi "example.com/catalog/internal/api"\n' +
        '\t"github.com/gin-gonic/gin/binding"\n' +
        ')\n',
      'internal/api/routes.go': 'package api\n\nimport "example.com/catalog/internal/store"\n',
      'internal/store/store.go': 'package store\n',
    })

    const observations = await scan(repo)

    expect(edges(observations)).toEqual([
      // A Go import names a package directory; the dependency lands on its
      // first source file, whose ownership stands for the directory's.
      'cmd/server/main.go -> file:internal/api/routes.go',
      // The external import path maps back to the module go.mod requires.
      'cmd/server/main.go -> module:github.com/gin-gonic/gin',
      'internal/api/routes.go -> file:internal/store/store.go',
    ])
  })
})

describe('rust', () => {
  test('resolves mod declarations and crate paths, skips std and same-module paths', async () => {
    const repo = scratchRepo({
      'src/main.rs': 'mod scoring;\n\nuse std::collections::HashMap;\nuse serde::Deserialize;\nuse crate::scoring::runs::Score;\n',
      'src/scoring.rs': 'pub mod runs;\n\nuse self::runs::Run;\n',
      'src/scoring/runs.rs': 'use super::helpers;\n',
    })

    const observations = await scan(repo, ['src'])

    expect(edges(observations)).toEqual([
      'src/main.rs -> file:src/scoring.rs',
      'src/main.rs -> file:src/scoring/runs.rs',
      'src/main.rs -> module:serde',
      'src/scoring.rs -> file:src/scoring/runs.rs',
    ])
  })
})

describe('jvm', () => {
  test('resolves types through package-path suffixes and trims externals to the package', async () => {
    const repo = scratchRepo({
      'app/src/main/java/com/acme/api/Routes.java':
        'package com.acme.api;\n\n' +
        'import java.util.List;\n' +
        'import com.acme.core.Engine;\n' +
        'import com.acme.core.util.*;\n' +
        'import com.fasterxml.jackson.databind.ObjectMapper;\n',
      'app/src/main/java/com/acme/core/Engine.java': 'package com.acme.core;\n',
      'app/src/main/java/com/acme/core/util/Strings.java': 'package com.acme.core.util;\n',
      'app/src/main/kotlin/com/acme/cli/Main.kt':
        'package com.acme.cli\n\nimport kotlin.io.path.Path\nimport com.acme.core.Engine\n',
    })

    const observations = await scan(repo, ['app'])

    expect(edges(observations)).toEqual([
      'app/src/main/java/com/acme/api/Routes.java -> file:app/src/main/java/com/acme/core/Engine.java',
      'app/src/main/java/com/acme/api/Routes.java -> file:app/src/main/java/com/acme/core/util/Strings.java',
      'app/src/main/java/com/acme/api/Routes.java -> module:com.fasterxml.jackson.databind',
      'app/src/main/kotlin/com/acme/cli/Main.kt -> file:app/src/main/java/com/acme/core/Engine.java',
    ])
  })
})

describe('ruby', () => {
  test('resolves require_relative and lib requires, skips the stdlib, claims gems', async () => {
    const repo = scratchRepo({
      'lib/billing.rb': "require 'json'\nrequire 'billing/invoice'\nrequire 'sinatra/base'\n",
      'lib/billing/invoice.rb': "require_relative 'totals'\n",
      'lib/billing/totals.rb': '',
    })

    const observations = await scan(repo, ['lib'])

    expect(edges(observations)).toEqual([
      'lib/billing.rb -> file:lib/billing/invoice.rb',
      'lib/billing.rb -> module:sinatra',
      'lib/billing/invoice.rb -> file:lib/billing/totals.rb',
    ])
  })
})

describe('c', () => {
  test('resolves quoted includes, treats pathless angle includes as the toolchain', async () => {
    const repo = scratchRepo({
      'src/main.c':
        '#include <stdio.h>\n#include <boost/asio.hpp>\n#include "engine.h"\n#include "util/log.h"\n#include "missing.h"\n',
      'src/engine.h': '',
      'include/util/log.h': '',
    })

    const observations = await scan(repo, ['src', 'include'])

    expect(edges(observations)).toEqual([
      'src/main.c -> file:include/util/log.h',
      'src/main.c -> file:src/engine.h',
      'src/main.c -> module:boost',
      'src/main.c ->? module:missing.h',
    ])
  })
})

describe('coverage contracts', () => {
  test('emits a scan-root observation per root with its source count', async () => {
    const repo = scratchRepo({
      'src/a.py': '',
      'scripts/b.py': '',
    })
    const observations = await scan(repo, ['src', 'scripts'])
    const scanRoots = observations.filter((o) => o.kind === 'scan-root')
    expect(scanRoots.map((o) => [o.id, o.data?.files])).toEqual([
      ['scan-root:src', 1],
      ['scan-root:scripts', 1],
    ])
  })

  test('a root with no source in a language it reads throws instead of passing silently', async () => {
    const repo = scratchRepo({ 'src/README.md': 'no code here' })
    await expect(scan(repo, ['src'])).rejects.toThrow(/contains no source/)
  })

  test('a root that is not a directory throws', async () => {
    const repo = scratchRepo({ 'src/a.py': '' })
    await expect(scan(repo, ['absent'])).rejects.toThrow(/not a directory/)
  })

  test('no roots configured throws', async () => {
    const repo = scratchRepo({ 'src/a.py': '' })
    await expect(scan(repo, [])).rejects.toThrow(/no scan roots/)
  })

  test('skips dependency dirs anywhere and build output at the root only', async () => {
    const repo = scratchRepo({
      'src/a.py': 'import app\n',
      'src/app/__init__.py': '',
      'src/app/__pycache__/junk.py': '',
      'src/node_modules/pkg/index.js': '',
      'src/dist/kept.py': '',
      'dist/dropped.py': '',
      'vendor/dropped.go': '',
    })
    const observations = await scan(repo)
    const files = observations.filter((o) => o.kind === 'file').map((o) => o.subject?.id)
    expect(files).toEqual(['src/a.py', 'src/app/__init__.py', 'src/dist/kept.py'])
  })

  test('tooling config files are skipped at the repository root only', async () => {
    const repo = scratchRepo({
      'fitc4.config.mts': "import { defineConfig } from '@arocnies/fitc4'\n",
      'vite.config.ts': "import { defineConfig } from 'vite'\n",
      'src/report.config.ts': 'export const wired = true\n',
      'src/main.ts': "import './report.config.ts'\n",
    })
    const observations = await scan(repo)
    const files = observations.filter((o) => o.kind === 'file').map((o) => o.subject?.id)
    expect(files).toEqual(['src/main.ts', 'src/report.config.ts'])
  })

  test('two references to one specifier on one line stay distinct via ordinals', async () => {
    const repo = scratchRepo({
      'src/a.js': "const x = require('./b'); const y = require('./b')\n",
      'src/b.js': '',
    })
    const observations = await scan(repo, ['src'])
    const ids = observations
      .filter((o) => o.kind === 'dependency')
      .map((o) => o.id)
      .sort()
    expect(ids).toEqual(['dependency:src/a.js:1#1->./b', 'dependency:src/a.js:1->./b'])
  })

  test('evidence cites the importing file, line, and specifier as written', async () => {
    const repo = scratchRepo({
      'src/a.py': '# leading comment\nimport yaml\n',
    })
    const observations = await scan(repo, ['src'])
    const dependency = observations.find((o) => o.kind === 'dependency')
    expect(dependency?.evidence).toEqual([{ path: 'src/a.py', line: 2, detail: 'yaml' }])
  })
})

describe('ignore', () => {
  const scanIgnoring = (
    repositoryRoot: string,
    ignore: string[],
    scanRoots?: string[],
  ): Promise<Observation[]> =>
    importScan(scanRoots === undefined ? { ignore } : { ignore, roots: scanRoots }).run({
      repositoryRoot,
    })

  // The brownfield case this exists for: a second copy of the source living in
  // the repository, which the built-in skip list cannot know about.
  test('a bare path drops its whole subtree', async () => {
    const repo = scratchRepo({
      'src/app.py': 'import yaml\n',
      '_scratch/copy/src/app.py': 'import yaml\n',
    })
    const observations = await scanIgnoring(repo, ['_scratch'])
    expect(observations.filter((o) => o.kind === 'file').map((o) => o.subject?.id)).toEqual([
      'src/app.py',
    ])
  })

  test('a glob drops matching files wherever they sit', async () => {
    const repo = scratchRepo({
      'src/app.py': '',
      'src/generated_client.py': '',
      'src/deep/generated_client.py': '',
    })
    const observations = await scanIgnoring(repo, ['**/generated_*.py'])
    expect(observations.filter((o) => o.kind === 'file').map((o) => o.subject?.id)).toEqual([
      'src/app.py',
    ])
  })

  // An ignored file is gone from the file tree the resolver matches against,
  // not merely unreported, so an import into one resolves the way any import
  // out of the scanned tree does: by each language's own rule. A Python
  // package import becomes a claimable external module, which is the honest
  // reading of a subtree the config disowned, while a relative import has
  // nothing left to name and is unresolved.
  test('an import into an ignored path leaves the repository', async () => {
    const repo = scratchRepo({
      'src/app.py': 'from generated.client import Client\n',
      'src/generated/__init__.py': '',
      'src/generated/client.py': '',
      'src/app.js': "import { c } from './generated/client.js'\n",
      'src/generated/client.js': '',
    })

    expect(edges(await scan(repo, ['src']))).toEqual([
      'src/app.js -> file:src/generated/client.js',
      'src/app.py -> file:src/generated/client.py',
    ])
    expect(edges(await scanIgnoring(repo, ['src/generated'], ['src']))).toEqual([
      'src/app.js ->? module:./generated/client.js',
      'src/app.py -> module:generated',
    ])
  })

  test('an ignore that empties a root fails loudly', async () => {
    const repo = scratchRepo({ 'src/app.py': '' })
    await expect(scanIgnoring(repo, ['src'], ['src'])).rejects.toThrow(/contains no source/)
  })

  test('a pattern that names nothing is a config error', () => {
    expect(() => importScan({ ignore: ['./'] })).toThrow(/matches nothing it could name/)
  })
})

describe('isTestPath', () => {
  test.each([
    'src/thing.test.ts',
    'src/thing.spec.js',
    'src/test_thing.py',
    'src/thing_test.py',
    'src/thing_test.go',
    'src/thing_spec.rb',
    'src/ThingTest.java',
    'src/ThingTests.kt',
    'src/__tests__/thing.py',
    'src/tests/deep/thing.py',
    'pkg/testdata/thing.go',
  ])('%s is a test path', (relative) => {
    expect(isTestPath(relative)).toBe(true)
  })

  test.each([
    'src/thing.py',
    'src/contest.py',
    'src/latest/thing.go',
    'src/attestThing.java',
    'src/tests.py',
  ])('%s is source', (relative) => {
    expect(isTestPath(relative)).toBe(false)
  })
})
