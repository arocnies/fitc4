/**
 * supabase/draft: bootstrap a first model from the pinned compose file, with
 * no model in sight, and score the draft against the transcribed reference.
 *
 * This variant is the end-to-end proof of fragment-derived draft elements:
 * eleven services whose entire declared architecture lives in one file, so no
 * directory mirror can give each service an element. The scan provider is the
 * same focused `agentScan` the gate variants use, with one added instruction:
 * emit one `file` observation per service fragment locator
 * (`docker/docker-compose.yml#services.<name>`), the same rule a real user
 * drafting from this config would write. Draft turns each distinct fragment
 * into its own element claiming the locator verbatim, nested under a
 * container element for the compose file, and the fifteen dependency
 * observations resolve onto the fragment elements by the ordinary
 * longest-claim rule: eleven elements and twelve edges drafted from one file.
 *
 * The `arch/` overlay is deliberately not copied in, and the draft is written
 * to a fresh directory inside the disposable work tree, exactly as in the
 * other draft variants. Scoring lives in harness/draft.ts; expectations.json
 * restates the gate model's eleven services and twelve oracle edges as draft
 * references, matched by sources claim, which here is the fragment locator.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type ResolvedConfig } from '@arocnies/fitc4'
import type { AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { supabaseScan, SCAN_INSTRUCTIONS } from '../greenfield/fitc4.eval.ts'

/**
 * Opt into the describe pass: the harness builds a draft describer from this
 * fixture's exec, so each drafted service element gets one describe call, and
 * scoring asserts every claiming element carries a non-TODO description. The
 * describe replies in replies.json match on the fragment locator each prompt
 * names.
 */
export const describe = true

export const DRAFT_INSTRUCTIONS =
  SCAN_INSTRUCTIONS +
  " Additionally, emit one observation of kind 'file' with subject { kind: 'file', id: " +
  "'docker/docker-compose.yml#services.<name>' } for every service declared under the " +
  "top-level 'services:' key, one observation per service, citing the compose file and the " +
  'line declaring the service as evidence.'

export default function supabaseDraft(exec: AgentExec, root: string): ResolvedConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'supabase-draft',
    checkout,
    overlayDir: fixtureDir,
    // No overlay: a draft run has no authored model, that is the premise.
    overlay: [],
  })

  return {
    repositoryRoot: work,
    // Fresh and empty, so draft's never-overwrite rule has nothing to trip on.
    modelDir: path.join(work, 'draft'),
    // The observations are fragment locators inside docker/, so the scan's
    // attested root only anchors what a directory mirror would cover; here it
    // covers nothing and every element comes from a fragment.
    scan: [supabaseScan(exec, DRAFT_INSTRUCTIONS)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
