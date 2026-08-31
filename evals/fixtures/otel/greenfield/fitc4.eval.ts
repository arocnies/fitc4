/**
 * otel/greenfield: the pinned OpenTelemetry Demo compose stack, unmodified,
 * under our transcription of the architecture it states for itself.
 *
 * This fixture is the near-zero tier by construction: its BASE row runs on
 * `USER_HINT`, the two sentences the stack's owner would actually type, and
 * its one angle drops even those for the shipped default. There is no
 * fixture-authored oracle prose at all, deliberately — the question the
 * fixture asks is what fitc4 recovers from a system-design-shaped stack (a
 * cache, a broker, a front proxy, a feature-flag daemon, twenty-odd services)
 * before anyone writes instructions.
 *
 * The upstream repository is fetched into evals/.cache/ on demand (see
 * ../external.json and harness/external.ts) and assembled with our overlay
 * (arch/) into a fresh working directory per run. `agentScan` runs in focused
 * one-shot mode over compose.yaml and the compose.full.yaml overlay: their
 * contents are embedded in the request, and the ideal reply reports each
 * depends_on entry and each service-naming _ADDR/_HOST environment reference
 * — the variable's own key, or a ${...} reference inside a value — as a
 * `dependency` observation between services, in service-name vocabulary
 * — `source-root` resolves the names onto the elements, exercising name
 * resolution on every CI run the way boutique@user-hint does. `.env` never
 * enters the context (the listing skips hidden files), so the var NAME
 * convention, not any value, is what states the thirteen edges depends_on
 * alone would miss, shipping -> quote, the collector's scrape targets, and
 * the ${OTEL_COLLECTOR_HOST} exporter endpoints among them.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

/**
 * What the stack's owner would type on day one: which files declare the
 * services, and the address-variable convention. Two sentences, 25 words.
 * The first live pass ran with `_ADDR` alone and measured the cost of the
 * missing suffix immediately: gpt-5.6-luna read email's FLAGD_HOST as the
 * true edge it is, and the answer key of that day scored the honest reading
 * as an error. The convention is the repository's, `_ADDR` and `_HOST`
 * alike, so the hint states it whole. What counts as a dependency inside a
 * compose file — depends_on, the var names themselves — stays deliberately
 * absent: that is compose knowledge, not repository knowledge, and this
 * fixture measures whether the tool and the model supply it.
 */
export const USER_HINT =
  'compose.yaml and the compose.full.yaml overlay declare every service of this stack. ' +
  'Env vars ending in _ADDR or _HOST name the service each one points at.'

/** The `agent-scan` options every tier shares; only the instructions differ. */
export function otelScan(exec: AgentExec, instructions?: string) {
  return agentScan({
    exec,
    id: 'compose',
    roots: ['.'],
    // One-shot focused mode: both compose files' CONTENTS are embedded in the
    // request, so the reply can only come from them, and a `cached()` live
    // run is invalidated by any edit. 25000 chars covers each file whole
    // (compose.yaml is 24430 bytes at the pin, the overlay 4880).
    focus: ['compose.yaml', 'compose.full.yaml'],
    excerptChars: 25_000,
    ...(instructions === undefined ? {} : { instructions }),
  })
}

export default function otelGreenfield(exec: AgentExec, root: string): PipelineConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'otel-greenfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [otelScan(exec, USER_HINT)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

export const angles = {
  /**
   * Zero authored words over the same focused files: the shipped import-scan
   * default reading files that declare services, not imports. The floor row,
   * and this fixture's floor is the quiet kind: both compose files are
   * reported and unowned (two warnings), every element's src/ claim sits
   * outside the attested scan roots and is legally silent, and none of the 64
   * declared relationships is exercised. Out of the box the gate is green and
   * checks nothing — the floor shape most worth displaying next to what two
   * sentences buy.
   */
  'default-prompt': (exec: AgentExec, root: string): PipelineConfig => {
    const config = otelGreenfield(exec, root)
    return {
      ...config,
      scan: [otelScan(exec)],
    }
  },
}
