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

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'
import { without } from '../../../harness/prose.ts'

/**
 * Where the fragment locator this fixture teaches must NOT appear. Named so
 * the `no-fragment-note` angle subtracts exactly it: it is a rule about the
 * reply format, not a fact about the compose file.
 */
export const FRAGMENT_NOTE =
  'Evidence paths and examined entries are plain file paths without fragments; ' +
  'list every file you read in examined.'

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
  'file says rather than what looks consistent. ' +
  FRAGMENT_NOTE

/**
 * The `agent-scan` options every variant shares; only the workdir differs.
 * The draft variant passes its own instructions, the gate instructions plus
 * one extra rule; everything else stays identical.
 */
export function supabaseScan(exec: AgentExec, instructions: string = SCAN_INSTRUCTIONS) {
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
    instructions,
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
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

/**
 * The same compose file with the fragment-format rule removed.
 *
 * This fixture teaches the model a locator form the shipped prompt allows,
 * `<path>#<fragment>`, and then has to spend a clause telling it where that
 * form is NOT allowed: evidence paths and `examined` entries take plain
 * paths. Both go through the throwing path guard with the fragment attached,
 * so a model that carries the locator into its citations kills the scan.
 *
 * The shipped prompt states the permission and never states the limit, which
 * makes this clause a patch over a gap in the prompt rather than a fact about
 * Supabase. The angle drops it and keeps the `examined` sentence it was
 * bundled with, so the only variable is whether the model works out on its
 * own that a citation is a file, not a region.
 */
export const angles = {
  /**
   * The working config plus a second scanner pointed at the whole repository:
   * default `roots`, default instructions, the general import scan exploring
   * read-only. This is `agentScan({ exec })` with nothing configured, which is
   * what a user gets for writing the shortest possible agent scan.
   *
   * The question is over-interpretation, and this repository asks it fairly
   * without any planting. Upstream ships ELEVEN alternative compose files
   * beside the one the architecture describes: caddy, envoy, kong, nginx,
   * pg15, pg17, pgbouncer, rustfs, s3, logs, dev. Each declares its own
   * `services:` block for a deployment variant that is not this architecture.
   * A scanner that reads them as statements about the system produces edges the
   * model has no reason to declare, and every one of those becomes a
   * `missing-relationship` error against a model that was correct.
   *
   * What it pins is corruption, not noise, because the first live pass showed
   * those are different things. Sonnet read fifty-odd files and produced
   * fifty-one findings the model has no use for, every one a warning: 49
   * `unmapped-source` for infrastructure config the model never claimed, and 2
   * `unresolved-import` for paths leading out of the repository (a dev compose
   * build context at ../apps/studio, and a container-internal /etc/envoy
   * path). It invented no edge between model elements and produced no error at
   * all. So `findingsMustNot` pins the errors, `missing-relationship` and
   * `relationship-direction`, and the warnings are left to accumulate as the
   * measured cost.
   *
   * That cost is mostly arithmetic. The model claims compose fragments, so
   * every file this scan reports is unowned and each one is a warning.
   * Pointing a scanner at more repository than the model describes buys a
   * warning per file, by design, and the judgement call it leaves a user is
   * whether that noise is worth the coverage.
   */
  'whole-repo': (exec: AgentExec, root: string): PipelineConfig => {
    const config = supabaseGreenfield(exec, root)
    return { ...config, scan: [...config.scan, agentScan({ exec, id: 'repo' })] }
  },
  'no-fragment-note': (exec: AgentExec, root: string): PipelineConfig => {
    const config = supabaseGreenfield(exec, root)
    return {
      ...config,
      scan: [
        supabaseScan(
          exec,
          // Subtract the bundled sentence whole, then restate only the half
          // that is not under test: `examined` is the shipped prompt's own
          // rule, repeated here, and removing it would change two things.
          `${without(SCAN_INSTRUCTIONS, FRAGMENT_NOTE, 'no-fragment-note')} List every file you read in examined.`,
        ),
      ],
    }
  },
}
