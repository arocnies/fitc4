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
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from 'fitc4'
import { agentScan, type AgentExec } from 'fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

export const SCAN_INSTRUCTIONS =
  'Each kubernetes-manifests/<name>.yaml deploys the Online Boutique service <name>. A manifest ' +
  'declares its service\'s outbound dependencies as container env vars whose names end in ' +
  "_SERVICE_ADDR; each value is '<target>:<port>' where <target> is the name of the target " +
  'service. Every service <name> is implemented by its build directory src/<name>, and the file ' +
  'src/<name>/Dockerfile stands in for the service wherever a fact needs a file (the one ' +
  'exception is cartservice, whose Dockerfile lives at src/cartservice/src/Dockerfile). For ' +
  "every _SERVICE_ADDR env var, emit one observation of kind 'dependency' with subject " +
  "{ kind: 'file', id: <the declaring service's stand-in file> } and target { kind: 'file', " +
  "id: <the target service's stand-in file> }, citing the manifest and the env var's line as " +
  'evidence. Ignore env vars whose names do not end in _SERVICE_ADDR (PORT, REDIS_ADDR, ' +
  'FRONTEND_ADDR and similar), and report no dependencies for kustomization.yaml, which deploys ' +
  'no service. List every manifest you read in examined, including manifests that contribute ' +
  'no dependencies.'

/**
 * The `agent-scan` options the variants share; only the workdir differs, and
 * the draft variant appends one rule to the instructions.
 */
export function boutiqueScan(exec: AgentExec, instructions: string = SCAN_INSTRUCTIONS) {
  return agentScan({
    exec,
    id: 'manifests',
    roots: ['kubernetes-manifests'],
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
