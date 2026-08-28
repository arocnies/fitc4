/**
 * ecom/greenfield: the pinned AWS Serverless Ecommerce Platform sources,
 * unmodified, under our transcription of the architecture its metadata.yaml
 * files declare themselves.
 *
 * The upstream repository is fetched into evals/.cache/ on demand (see
 * ../external.json and harness/external.ts) and assembled with our overlay
 * (arch/) into a fresh working directory per run. `agentScan` runs in focused
 * one-shot mode over each service's metadata.yaml and SAM template: the files'
 * contents are embedded in the request, the agent reports each declared
 * dependency and each SSM parameter path wired into the stack as a
 * `dependency` observation between the services' metadata.yaml files, and the
 * stock resolver and rules judge those edges exactly as they judge imports.
 *
 * Unlike the other greenfield variants, the pristine tree is not clean:
 * orders' own metadata.yaml wires payment's API in under `parameters:` while
 * omitting payment from `dependencies:`. That is genuine drift shipped by
 * upstream, and the expectations pin the resulting `missing-relationship`
 * error as a real finding of the pinned sources.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

import { assembleWorkdir, ensureCheckout, externalManifest } from '../../../harness/external.ts'

/** The ten service directories; pipeline/ is the CI/CD stack, not a service. */
export const SERVICE_DIRECTORIES = [
  'delivery',
  'delivery-pricing',
  'frontend-api',
  'orders',
  'payment',
  'payment-3p',
  'platform',
  'products',
  'users',
  'warehouse',
]

export const SCAN_INSTRUCTIONS =
  'Each of the top-level service directories (delivery, delivery-pricing, frontend-api, orders, ' +
  'payment, payment-3p, platform, products, users, warehouse) holds a metadata.yaml describing ' +
  'one service of this platform, and all but payment-3p hold a SAM template.yaml. The file ' +
  "<service>/metadata.yaml stands in for the service wherever a fact needs a file. Report two " +
  "kinds of facts, each as one observation of kind 'dependency' with subject { kind: 'file', " +
  "id: '<declaring service>/metadata.yaml' } and target { kind: 'file', id: '<target " +
  "service>/metadata.yaml' }, citing the metadata.yaml line as evidence. First, each entry of a " +
  "metadata.yaml 'dependencies:' list is one declared dependency on the named service. Second, " +
  "each SSM parameter path under a metadata.yaml 'parameters:' key names a target service in " +
  "its second path segment (/ecommerce/{Environment}/<target service>/...), and each DISTINCT " +
  'target service wired this way is one dependency; these paths feed the typed ' +
  'AWS::SSM::Parameter::Value parameters the same service declares in its template.yaml. ' +
  "Report both kinds even when they duplicate each other, and report exactly what the files " +
  'say rather than what looks consistent. Ignore EventBridge event patterns, permissions ' +
  'blocks, and everything else in the templates. List every file you read in examined, ' +
  'including files that contribute no dependencies.'

/**
 * The two-sentence tier: where the services are described and the one
 * non-obvious wiring channel, in the words of someone who owns the repo. The
 * oracle's remaining 160-odd words — the observation shape, the stand-in
 * file, the path-segment rule, the duplicate-reporting convention, the
 * exclusions — are the tool's job, and the `user-hint` angle measures whether
 * the tool does it.
 */
export const USER_HINT =
  "Each top-level service directory's metadata.yaml describes one service and lists its " +
  'dependencies. Services are also wired together through SSM parameter paths under ' +
  '/ecommerce/.'

/** The `agent-scan` options the variants share; only workdir and prose differ. */
export function ecomScan(exec: AgentExec, instructions: string = SCAN_INSTRUCTIONS) {
  return agentScan({
    exec,
    id: 'metadata',
    roots: SERVICE_DIRECTORIES,
    // One-shot focused mode: the files' CONTENT is embedded in the request,
    // so the reply can only come from them, and a `cached()` live run is
    // invalidated by any edit to a focused file. 2000 chars covers every
    // metadata.yaml whole and every template.yaml through the end of its
    // Parameters block (the largest, frontend-api's, ends at byte 1317).
    focus: ['*/metadata.yaml', '*/template.yaml'],
    excerptChars: 2_000,
    instructions,
  })
}

export default function ecomGreenfield(exec: AgentExec, root: string): PipelineConfig {
  const fixtureDir = path.dirname(root)
  const evalsDir = path.resolve(fixtureDir, '..', '..')
  const manifest = externalManifest(root)
  if (manifest === undefined) throw new Error(`no ${path.join(fixtureDir, 'external.json')}`)

  const checkout = ensureCheckout(evalsDir, manifest)
  const work = assembleWorkdir({
    evalsDir,
    name: 'ecom-greenfield',
    checkout,
    overlayDir: fixtureDir,
    overlay: ['arch'],
  })

  return {
    repositoryRoot: work,
    modelDir: path.join(work, 'arch'),
    scan: [ecomScan(exec)],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

/**
 * The near-zero tier over the same pinned sources.
 *
 * `default-prompt` is the floor with a real defect in frame: the shipped
 * import scan reads 19 YAML files that contain no imports, every file is
 * owned by its own element, so the run is quiet green — and the genuine
 * upstream orders -> payment drift the base row pins goes unseen. That is
 * what zero authored words buys here, pinned so the distance to the hint is
 * measured rather than assumed.
 *
 * `user-hint` is the two sentences above. The ideal reply speaks bare service
 * names (the directory names), each distinct edge once — no oracle
 * bookkeeping conventions — and the resolver carries the names onto the
 * elements, spelling differences included (delivery-pricing ->
 * deliveryPricing). The upstream drift error must survive the vocabulary.
 */
export const angles = {
  'default-prompt': (exec: AgentExec, root: string): PipelineConfig => {
    const config = ecomGreenfield(exec, root)
    return {
      ...config,
      scan: [
        agentScan({
          exec,
          id: 'metadata',
          roots: SERVICE_DIRECTORIES,
          focus: ['*/metadata.yaml', '*/template.yaml'],
          excerptChars: 2_000,
        }),
      ],
    }
  },

  'user-hint': (exec: AgentExec, root: string): PipelineConfig => {
    const config = ecomGreenfield(exec, root)
    return { ...config, scan: [ecomScan(exec, USER_HINT)] }
  },
}
