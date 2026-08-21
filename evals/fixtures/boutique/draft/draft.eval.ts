/**
 * boutique/draft: bootstrap a first model from the pinned manifests, with no
 * model in sight, and score the draft against the transcribed reference.
 *
 * `fitc4 draft` runs the configured scan providers and nothing else, which is
 * its natural condition: it exists for the moment before any model does. So
 * this variant hands `draft()` the same focused `agentScan` the other
 * variants gate with, and the reference model is never in the picture. The
 * `arch/` overlay is deliberately not copied in, and the draft is written to
 * a fresh directory inside the disposable work tree.
 *
 * One addition to the greenfield instructions: draft derives elements from
 * `file` observations, and the dependency-only greenfield scan emits none, so
 * the instructions also ask for one `file` observation per service stand-in.
 * That is the same rule a user drafting from an agent-scan config would have
 * to write. Everything else, the roots, the focus, the env-var oracle, is the
 * greenfield scan verbatim.
 *
 * Scoring lives in harness/draft.ts: the drafted elements and relationships
 * against expectations.json, which restates the reference model as data.
 */

import path from 'node:path'

import type { ResolvedConfig } from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { boutiqueScan, SCAN_INSTRUCTIONS } from '../greenfield/fitc4.eval.ts'

export const DRAFT_INSTRUCTIONS =
  SCAN_INSTRUCTIONS +
  " Additionally, emit one observation of kind 'file' with subject { kind: 'file', id: <stand-in " +
  'file> } for every service a manifest deploys and for every target service of a dependency you ' +
  'report, one observation per distinct stand-in file, citing the manifest that names the ' +
  'service as evidence.'

export default function boutiqueDraft(exec: AgentExec, root: string): ResolvedConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'boutique-draft',
    checkout,
    overlayDir: fixtureDir,
    // No overlay: a draft run has no authored model, that is the premise.
    overlay: [],
  })

  return {
    repositoryRoot: work,
    // Fresh and empty, so draft's never-overwrite rule has nothing to trip on.
    modelDir: path.join(work, 'draft'),
    // Draft derives element prefixes from the scan roots; the services'
    // stand-in files live under src/<name>/.
    scanRoots: ['src'],
    // Never read: the configured scan below replaces the TypeScript scanner.
    tsconfigPath: path.join(work, 'tsconfig.json'),
    providers: {
      scan: [boutiqueScan(exec, DRAFT_INSTRUCTIONS)],
    },
  }
}
