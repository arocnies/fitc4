/**
 * boutique/brownfield: the same pinned manifests with ../patches/*.patch
 * applied.
 *
 * The one patch plants an undeclared service edge: recommendationservice.yaml
 * gains a PAYMENT_SERVICE_ADDR env var, pointing the recommendation service
 * at the payment service. The naming convention makes the plant real. It is
 * exactly how every declared edge in these manifests is written, so an honest
 * scan must report it like any other, and the transcribed model turns it into
 * one pinned `missing-relationship` error. This is the fixture's point: the
 * agent's observations are the gate's only coverage here, so a wrong or
 * tidied-away observation changes the findings by construction.
 */

import fs from 'node:fs'
import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { boutiqueScan } from '../greenfield/fitc4.eval.ts'

export default function boutiqueBrownfield(exec: AgentExec, root: string): PipelineConfig {
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
    name: 'boutique-brownfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
    patches,
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [boutiqueScan(exec)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
