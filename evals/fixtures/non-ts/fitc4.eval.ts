/**
 * Non-TS: a model domain no TypeScript parser sees — evaluates `agentScan` in
 * focused one-shot mode.
 *
 * There is no TypeScript here at all: the implementation is a compose file,
 * and the model declares the services (a custom `service` element kind) with
 * each service owning its build-context directory. `agentScan` reads the
 * embedded `docker-compose.yml` excerpt and reports each `depends_on` edge as
 * a standard `dependency` observation between the services' Dockerfiles — the
 * files that ground a service in the repository — and from there the stock
 * `source-root` resolver and `architecture-rules` judge the edges exactly as
 * they judge TypeScript imports. Ground truth: web → api and api → db are
 * declared and pass; web → db is planted in the compose file and forbidden by
 * the model, so it must surface as a `missing-relationship` error.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

/**
 * The two-sentence tier: the two facts a user whose model claims these
 * directories would type on day one, and nothing about output shape. What a
 * compose dependency IS (depends_on), which file stands in for a service, and
 * what to put in `examined` are all the tool's job here.
 */
export const USER_HINT =
  'docker-compose.yml defines the services this deployment runs. Each service <name> is ' +
  'implemented under services/<name>.'

export const INSTRUCTIONS =
  'docker-compose.yml defines the services this deployment runs. Each compose service ' +
  '<name> is implemented by its build-context directory services/<name>, and the file ' +
  "services/<name>/Dockerfile stands in for the service wherever a fact needs a file. Emit: " +
  "(1) one observation of kind 'service' per compose service, with subject " +
  "{ kind: 'service', id: <name> }; " +
  '(2) for every depends_on entry where service A lists service B, one observation of kind ' +
  "'dependency' with subject { kind: 'file', id: 'services/A/Dockerfile' } and target " +
  "{ kind: 'file', id: 'services/B/Dockerfile' }, citing docker-compose.yml and the line of " +
  'the depends_on entry as evidence.'

function nonTsConfig(exec: AgentExec, root: string, instructions?: string): PipelineConfig {
  return {
    repositoryRoot: root,
    modelDir: path.join(root, 'arch'),
    scan: [
      agentScan({
        exec,
        id: 'compose',
        roots: ['.'],
        // One-shot: the compose file's CONTENT is embedded in the request, so
        // the reply can only come from it — and a `cached()` live run is
        // invalidated by any edit to the file.
        focus: ['docker-compose.yml'],
        ...(instructions === undefined ? {} : { instructions }),
      }),
    ],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

export default function nonTs(exec: AgentExec, root: string): PipelineConfig {
  return nonTsConfig(exec, root, INSTRUCTIONS)
}

/**
 * The near-zero tier over the same compose file, mirroring the boutique and
 * supabase pairs: `default-prompt` is the floor (zero authored words, the
 * shipped import scan reading a file that declares services, not imports) and
 * `user-hint` is the two sentences above, measuring whether the tool plus a
 * model's own compose literacy recover the edges the 94-word oracle used to
 * spell out.
 */
export const angles = {
  'default-prompt': (exec: AgentExec, root: string): PipelineConfig => nonTsConfig(exec, root),
  'user-hint': (exec: AgentExec, root: string): PipelineConfig =>
    nonTsConfig(exec, root, USER_HINT),
}
