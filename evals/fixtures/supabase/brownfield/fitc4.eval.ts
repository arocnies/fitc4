/**
 * supabase/brownfield: the same pinned compose file with ../patches/*.patch
 * applied.
 *
 * The one patch plants an undeclared service edge the way this file actually
 * wires one: the auth service's send-email hook, shipped commented out by
 * upstream with an external example host, is enabled and pointed at the
 * in-stack edge-functions service (GOTRUE_HOOK_SEND_EMAIL_URI:
 * http://functions:9000/email_sender). Nothing else changes, so the compose
 * file now states an auth -> functions dependency the model does not declare.
 * An honest scan must report the planted edge like any other literal
 * service-host URL, and the transcribed model turns it into the pinned
 * `missing-relationship` error. That is the fragment mechanism under load:
 * both endpoints live in the same file, and only per-service fragment
 * ownership makes the wrong edge land between two different elements instead
 * of dissolving inside a blanket claim.
 */

import fs from 'node:fs'
import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { supabaseScan } from '../greenfield/fitc4.eval.ts'

export default function supabaseBrownfield(exec: AgentExec, root: string): PipelineConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const patchesDir = path.join(fixtureDir, 'patches')
  const patches = fs
    .readdirSync(patchesDir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => path.join(patchesDir, name))

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'supabase-brownfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
    patches,
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [supabaseScan(exec)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
