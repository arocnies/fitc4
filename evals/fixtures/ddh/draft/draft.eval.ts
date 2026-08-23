/**
 * ddh/draft: bootstrap a first model from the pinned domain-driven-hexagon
 * sources with the real TypeScript scanner, and score the draft against the
 * authored reference. Deterministic, and still humbling in the details.
 *
 * Unlike boutique/draft there is no agent anywhere in this variant: the scan
 * provider is the stock `typescript-imports` scanner the default pipeline
 * composes, so stub and live mode run the identical free scan. What the
 * fixture measures is `draft()` itself, structural splitting included: a
 * directory splits into nested elements where observed imports cross between
 * its subdirectories and collapses where none do, which reaches deep into
 * this codebase's module layout. The remaining gap to the reference model
 * (../arch/model.c4, restated in expectations.json) is conceptual rather
 * than mechanical, and the expectations pin it explicitly (`expectedMiss`
 * entries and `expectedExtras`), the same philosophy as ecom pinning a real
 * upstream error: the honest score is the fixture, not a blemish on it.
 *
 * The `arch/` overlay is deliberately not copied in, and the draft is written
 * to a fresh directory inside the disposable work tree, exactly as in
 * boutique/draft.
 */

import path from 'node:path'

import {
  architectureRules,
  sourceRoot,
  typescriptImports,
  type ResolvedConfig,
} from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

export default function ddhDraft(_exec: AgentExec, root: string): ResolvedConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'ddh-draft',
    checkout,
    overlayDir: fixtureDir,
    // No overlay: a draft run has no authored model, that is the premise.
    overlay: [],
  })

  return {
    repositoryRoot: work,
    // Fresh and empty, so draft's never-overwrite rule has nothing to trip on.
    modelDir: path.join(work, 'draft'),
    // The stock scanner over the same root the gate variants' config
    // declares, which is the point: stub and live mode run the identical
    // free scan. The exec parameter is never used.
    scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
