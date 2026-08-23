/**
 * ecom/brownfield: the same pinned sources with ../patches/*.patch applied.
 *
 * The one patch plants an undeclared service edge the way this repository
 * actually wires one: orders/template.yaml gains a WarehouseTableName typed
 * SSM parameter (AWS::SSM::Parameter::Value), and orders/metadata.yaml binds
 * it under `parameters:` to /ecommerce/{Environment}/warehouse/table/name,
 * the parameter warehouse's own template exports. The `dependencies:` list is
 * left untouched, which is exactly the disagreement the pristine tree already
 * ships once (orders wiring payment without declaring it): the wiring half of
 * metadata.yaml outruns the declared half. An honest scan must report the
 * planted edge like any other, and the transcribed model turns it into a
 * second pinned `missing-relationship` error next to the genuine upstream
 * one. That is this fixture's point: the agent's observations are the gate's
 * only coverage here, so a wrong or tidied-away observation changes the
 * findings by construction.
 */

import fs from 'node:fs'
import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { ecomScan } from '../greenfield/fitc4.eval.ts'

export default function ecomBrownfield(exec: AgentExec, root: string): PipelineConfig {
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
    name: 'ecom-brownfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
    patches,
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [ecomScan(exec)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
