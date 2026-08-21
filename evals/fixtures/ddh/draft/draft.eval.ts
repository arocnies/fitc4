/**
 * ddh/draft: bootstrap a first model from the pinned domain-driven-hexagon
 * sources with the real TypeScript scanner, and score the draft against the
 * authored reference. Deliberately humbling, and deterministic.
 *
 * Unlike boutique/draft there is no agent anywhere in this variant: the scan
 * provider is the stock `typescript-imports` scanner the default pipeline
 * composes, so stub and live mode run the identical free scan. What the
 * fixture measures is `draft()` itself, at its honest granularity: one
 * element per first-level directory under the scan root. The reference model
 * (../arch/model.c4, restated in expectations.json) lives two and three
 * directory levels deeper, so most of it is out of the draft's reach by
 * construction. The expectations pin that gap explicitly (`expectedMiss`
 * entries and `expectedExtras`), the same philosophy as ecom pinning a real
 * upstream error: the honest score is the fixture, not a blemish on it.
 *
 * The `arch/` overlay is deliberately not copied in, and the draft is written
 * to a fresh directory inside the disposable work tree, exactly as in
 * boutique/draft.
 */

import path from 'node:path'

import type { ResolvedConfig } from 'fitc4'
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
    // The same scan root the gate variants' fitc4.config.json declares.
    scanRoots: ['src'],
    tsconfigPath: path.join(work, 'tsconfig.json'),
    // No providers: `pipelineConfig` composes the default typescript-imports
    // scanner, which is the point. The exec parameter is never used.
  }
}
