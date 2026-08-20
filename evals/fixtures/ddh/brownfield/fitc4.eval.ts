/**
 * ddh/brownfield: the same pinned sources with ../patches/*.patch applied.
 *
 * Each patch plants one import that violates a NAMED rule of the project's
 * own .dependency-cruiser.js, and the expectations pin the exact fitc4
 * finding the transcribed model produces for it:
 *
 * - no-domain-to-infra-deps: user.entity.ts imports the concrete user
 *   repository (not its port), a `relationship-direction` error because the
 *   model declares only user.database -> user.domain.
 * - no-domain-to-app-deps: user.types.ts imports the exception interceptor
 *   (not the exempted AppRequestContext), a `missing-relationship` error.
 * - no-domain-to-api-deps: wallet.entity.ts imports the shared response
 *   base, a `missing-relationship` error.
 * - no-infra-to-api-deps: user.repository.ts imports a response DTO, a
 *   `missing-relationship` error.
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadConfig, pipelineConfig, type PipelineConfig } from 'fitc4'
import { agentResolve, type AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { RESOLVE_INSTRUCTIONS } from '../greenfield/fitc4.eval.ts'

export default function ddhBrownfield(exec: AgentExec, root: string): PipelineConfig {
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
    name: 'ddh-brownfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch', 'fitc4.config.json'],
    patches,
  })

  const base = pipelineConfig(loadConfig(path.join(work, 'fitc4.config.json')))
  return {
    ...base,
    resolve: [...base.resolve, agentResolve({ exec, instructions: RESOLVE_INSTRUCTIONS })],
  }
}
