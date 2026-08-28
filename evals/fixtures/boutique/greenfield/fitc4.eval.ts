/**
 * boutique/greenfield: the pinned Online Boutique manifests, unmodified,
 * under our transcription of the service graph they declare themselves.
 *
 * The upstream repository is fetched into evals/.cache/ on demand (see
 * ../external.json and harness/external.ts) and assembled with our overlay
 * (arch/) into a fresh working directory per run. This is the non-ts fixture
 * on a real codebase: no TypeScript anywhere in the checked domain, so
 * `agentScan` in focused one-shot mode is the only scanner. The manifests'
 * contents are embedded in the request, the agent reports each *_SERVICE_ADDR
 * env var as a `dependency` observation between the services' stand-in files,
 * and the stock resolver and rules judge those edges exactly as they judge
 * imports. Pristine manifests, transcribed model: the gate must be green.
 *
 * The instructions used to carry a correction to their own convention, naming
 * the one service whose Dockerfile sits a directory deeper than src/<name>.
 * Both models needed it, and neither should have: the fact was in the
 * repository the whole time and the request simply never showed it. `roots`
 * now covers src/ for its inventory, so the path is in the listing and the
 * prose is a domain oracle again, with nothing in it about cartservice.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

export const SCAN_INSTRUCTIONS =
  'Each kubernetes-manifests/<name>.yaml deploys the Online Boutique service <name>. A manifest ' +
  'declares its service\'s outbound dependencies as container env vars whose names end in ' +
  "_SERVICE_ADDR; each value is '<target>:<port>' where <target> is the name of the target " +
  'service. Every service <name> is implemented by its build directory src/<name>, and the ' +
  "service's Dockerfile under that directory stands in for it wherever a fact needs a file. For " +
  "every _SERVICE_ADDR env var, emit one observation of kind 'dependency' with subject " +
  "{ kind: 'file', id: <the declaring service's stand-in file> } and target { kind: 'file', " +
  "id: <the target service's stand-in file> }, citing the manifest and the env var's line as " +
  'evidence. Ignore env vars whose names do not end in _SERVICE_ADDR (PORT, REDIS_ADDR, ' +
  'FRONTEND_ADDR and similar), and report no dependencies for kustomization.yaml, which deploys ' +
  'no service. List every manifest you read in examined, including manifests that contribute ' +
  'no dependencies.'

/**
 * What the scan can SEE exists, as distinct from what it can read.
 *
 * The manifests are focused, so their contents are embedded. `src` is here for
 * its inventory alone: the instructions send the model to a Dockerfile under
 * src/<name>, and until the roots covered src/ there was no way to check that
 * a path was real. Two models independently wrote src/cartservice/Dockerfile
 * for a file that lives at src/cartservice/src/Dockerfile, and one of them
 * invented src/redis-cart/Dockerfile for a service with no build directory at
 * all, losing its entire reply to the path guard. Both facts are in this
 * listing. Paths cost almost nothing; contents would not fit.
 */
export const ROOTS = ['kubernetes-manifests', 'src']

/**
 * The `agent-scan` options the variants share; only the workdir differs, and
 * the draft variant appends one rule to the instructions. `roots` is a
 * parameter so the `no-inventory` angles can narrow it back to the focused
 * directory and measure what the listing is worth.
 */
export function boutiqueScan(
  exec: AgentExec,
  instructions: string = SCAN_INSTRUCTIONS,
  roots: string[] = ROOTS,
) {
  return agentScan({
    exec,
    id: 'manifests',
    roots,
    // One-shot focused mode: the manifests' CONTENT is embedded in the
    // request, so the reply can only come from them, and a `cached()` live
    // run is invalidated by any edit to a manifest. 4500 chars covers the
    // largest manifest (frontend.yaml, 4032 bytes) whole.
    focus: ['kubernetes-manifests/*.yaml'],
    excerptChars: 4_500,
    instructions,
  })
}

export default function boutiqueGreenfield(exec: AgentExec, root: string): PipelineConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'boutique-greenfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [boutiqueScan(exec)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

/**
 * What the repository's owner would type, having identified their own
 * conventions but written no instructions: the two facts that are not stated
 * in any one file. Two sentences, 18 words. Discovering the _SERVICE_ADDR
 * convention from scratch is a different, harder task this row does not
 * measure. Everything the gate instructions say beyond this —
 * emit kind 'dependency', stand a Dockerfile in for a service, ignore
 * REDIS_ADDR, list examined — is the tool's job, and the `user-hint` angle
 * measures whether the tool does it.
 *
 * The first live pass measured exactly one gap: both models answered in the
 * natural vocabulary, `{ kind: 'service', id: 'checkoutservice' }`, and the
 * resolver only spoke paths, so every edge vanished without a finding. The
 * fix went into the tool, not this prose: `source-root` now resolves a ref's
 * id as an element name when it is not a claimed path, and the angle's
 * expectations pin the service-name vocabulary end to end.
 */
export const USER_HINT =
  'Each kubernetes-manifests/<name>.yaml deploys the service implemented under src/<name>. ' +
  'Env vars ending in _SERVICE_ADDR name the services it calls.'

/**
 * The same manifests with the inventory taken away.
 *
 * `roots` narrows to the focused directory, which is what every focused scan
 * looked like before the inventory existed: the model is told a convention for
 * paths under src/ and given no way to check one. Sharing the base
 * expectations makes the comparison direct, and the divergence is the price of
 * the missing listing, in the units that matter. It is a measured price, not a
 * hypothetical: both models wrote src/cartservice/Dockerfile here, and the
 * dependency-target downgrade turned each into a warning rather than a dead
 * scan, so this row reads as two lost edges instead of nothing at all.
 */
export const angles = {
  'no-inventory': (exec: AgentExec, root: string): PipelineConfig => {
    const config = boutiqueGreenfield(exec, root)
    return {
      ...config,
      scan: [boutiqueScan(exec, SCAN_INSTRUCTIONS, ['kubernetes-manifests'])],
    }
  },

  /**
   * The same wiring with zero authored words: no `instructions` at all, so the
   * scan runs on the shipped import-scan default over files that contain no
   * imports. This is the floor. Whatever this row scores is what a user gets
   * for pointing the tool at manifests and writing nothing, and the distance
   * to the base row is the price of the prose, measured.
   */
  'default-prompt': (exec: AgentExec, root: string): PipelineConfig => {
    const config = boutiqueGreenfield(exec, root)
    return {
      ...config,
      scan: [
        agentScan({
          exec,
          id: 'manifests',
          roots: ROOTS,
          focus: ['kubernetes-manifests/*.yaml'],
          excerptChars: 4_500,
        }),
      ],
    }
  },

  /**
   * The two-sentence tier (18 words): `USER_HINT` instead of the 147-word oracle, with
   * its own expectations because the ideal reply speaks service names, not
   * Dockerfile stand-ins. The associations it must reach are the base row's
   * fifteen, verbatim — same graph, different words — so a miss here is a
   * vocabulary the tool stopped understanding, not a fact the hint omits.
   */
  'user-hint': (exec: AgentExec, root: string): PipelineConfig => {
    const config = boutiqueGreenfield(exec, root)
    return {
      ...config,
      scan: [boutiqueScan(exec, USER_HINT)],
    }
  },
}
