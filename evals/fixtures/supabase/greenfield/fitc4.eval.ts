/**
 * supabase/greenfield: the pinned Supabase self-hosting compose file,
 * unmodified, under our transcription of the architecture it states for
 * itself.
 *
 * The upstream monorepo is fetched into evals/.cache/ on demand as a sparse
 * checkout of docker/ alone (see ../external.json and harness/external.ts)
 * and assembled with our overlay (arch/) into a fresh working directory per
 * run. `agentScan` runs in focused one-shot mode over the single compose
 * file: its content is embedded in the request, and the agent reports each
 * depends_on entry and each literal service-host environment URL as a
 * `dependency` observation between fragment locators of the form
 * docker/docker-compose.yml#services.<name>.
 *
 * That fragment form is this fixture's point: all eleven services live in one
 * file, each model element claims its own region with a fragment `sources`
 * locator, and the stock resolver and rules judge the fragment edges exactly
 * as they judge imports. A wrong or missing subject changes the deterministic
 * findings by construction; there is no blanket claim to hide behind.
 */

import path from 'node:path'

import { defaultResolve, defaultValidate, type PipelineConfig } from 'fitc4'
import { agentScan, type AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

export const SCAN_INSTRUCTIONS =
  'docker/docker-compose.yml declares every service of the Supabase self-hosting stack under ' +
  "its top-level 'services:' key. The fragment locator " +
  "docker/docker-compose.yml#services.<name> stands in for the service <name> wherever a fact " +
  "needs a file. Report two kinds of facts, each as one observation of kind 'dependency' with " +
  "subject { kind: 'file', id: 'docker/docker-compose.yml#services.<declaring service>' } and " +
  "target { kind: 'file', id: 'docker/docker-compose.yml#services.<target service>' }, citing " +
  "the compose file and line as evidence. First, each key of a service's 'depends_on:' block " +
  'is one dependency on the named service. Second, each value in a service\'s "environment:" ' +
  'block containing a URL whose host is literally the name of another service declared in this ' +
  'file (like http://meta:8080) is one dependency on that service; count each distinct target ' +
  'service once per declaring service for this kind. A host written as a variable interpolation ' +
  'like ${POSTGRES_HOST} is a deployment choice, not a literal service reference; ignore it. ' +
  'Also ignore healthcheck commands, container names, network aliases, ports, and volume ' +
  'mounts. Report both kinds even when they duplicate each other, and report exactly what the ' +
  'file says rather than what looks consistent. Evidence paths and examined entries are plain ' +
  'file paths without fragments; list every file you read in examined.'

/** The `agent-scan` options both variants share; only the workdir differs. */
export function supabaseScan(exec: AgentExec) {
  return agentScan({
    exec,
    id: 'compose',
    roots: ['docker'],
    // One-shot focused mode: the compose file's CONTENT is embedded in the
    // request, so the reply can only come from it, and a `cached()` live run
    // is invalidated by any edit. 22000 chars covers the file whole (21336
    // bytes at the pin).
    focus: ['docker/docker-compose.yml'],
    excerptChars: 22_000,
    instructions: SCAN_INSTRUCTIONS,
  })
}

export default function supabaseGreenfield(exec: AgentExec, root: string): PipelineConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'supabase-greenfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [supabaseScan(exec)],
    resolve: [...defaultResolve],
    validate: [...defaultValidate],
  }
}
