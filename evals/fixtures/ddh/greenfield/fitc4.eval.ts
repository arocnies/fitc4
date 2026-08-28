/**
 * ddh/greenfield: the pinned domain-driven-hexagon sources, unmodified, under
 * our transcription of the project's own dependency-cruiser rules.
 *
 * The upstream repository is fetched into evals/.cache/ on demand (see
 * ../external.json and harness/external.ts) and assembled with our overlay
 * (arch/ and fitc4.config.mts) into a fresh working directory per run. The
 * deterministic gate must be green: the model transcribes what the pinned
 * code does and what its .dependency-cruiser.js permits, nothing more.
 *
 * `agentResolve` runs alongside the default resolver, as in the greenfield
 * fixture. Most external packages are claimed deterministically in the model,
 * leaving six candidate decisions: five sites-collapsed `slonik` decisions
 * whose one right mapping is the description-only `vendor.postgres` element,
 * and `nanoid`, which no element covers, so the right behavior is abstention.
 */

import path from 'node:path'

import { resolveConfig, type PipelineConfig } from '@arocnies/fitc4'
import { agentResolve, type AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

export const RESOLVE_INSTRUCTIONS =
  'The vendor system catalogs the third-party platform this service runs on. Map an external ' +
  'package onto the vendor element that covers it, including description-only elements that ' +
  'name the backing system a client package connects to. Map only what the catalog clearly ' +
  'covers; when no element speaks for a package, leave it unmapped.'

export default async function ddhGreenfield(exec: AgentExec, root: string): Promise<PipelineConfig> {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'ddh-greenfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch', 'fitc4.config.mts'],
  })

  const base = await resolveConfig(path.join(work, 'fitc4.config.mts'))
  return {
    ...base,
    resolve: [...base.resolve, agentResolve({ exec, instructions: RESOLVE_INSTRUCTIONS })],
  }
}

/**
 * The same sources with NO mapping instructions: the shipped prompt alone.
 *
 * The base instructions do not just frame the domain, they contain the
 * answer. "Including description-only elements that name the backing system a
 * client package connects to" IS the slonik decision: `vendor.postgres`
 * carries a description and no sources, and mapping slonik onto it is the one
 * right answer out of six decisions. A sentence that describes the correct
 * element in the abstract is a hint no real user would think to write, because
 * a real user does not know yet which package is about to be ambiguous.
 *
 * Removing it leaves the shipped `PROMPT` to carry both halves on its own: map
 * a client package onto the system it talks to, and abstain on `nanoid`, which
 * no element covers. The base expectations are shared, so this row passing
 * means the default prompt is enough here and the prose was decoration.
 */
export const angles = {
  'bare-resolve': async (exec: AgentExec, root: string): Promise<PipelineConfig> => {
    const config = await ddhGreenfield(exec, root)
    return {
      ...config,
      resolve: [...config.resolve.filter((provider) => provider.id !== 'agent-resolve'), agentResolve({ exec })],
    }
  },

  /**
   * The one-sentence tier: what the vendor system IS, and nothing about
   * description-only elements or abstention — the clause that contained the
   * slonik answer stays out. Shares the base expectations: the six decisions
   * must land the same with the shipped prompt carrying the judgment.
   */
  'user-hint': async (exec: AgentExec, root: string): Promise<PipelineConfig> => {
    const config = await ddhGreenfield(exec, root)
    return {
      ...config,
      resolve: [
        ...config.resolve.filter((provider) => provider.id !== 'agent-resolve'),
        agentResolve({
          exec,
          instructions:
            'The vendor system catalogs the third-party platforms and services this ' +
            'application runs on.',
        }),
      ],
    }
  },
}
