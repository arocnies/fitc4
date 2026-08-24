/**
 * Python: a repository the TypeScript scanner cannot see at all — evaluates
 * `agentScan` running its DEFAULT instructions, the general import scan, with
 * no prose written in the config. This is the out-of-the-box path for a
 * non-TypeScript repository (`init --agent` scaffolds exactly this shape when
 * no tsconfig.json exists), so what is measured is the shipped instructions,
 * not the user's.
 *
 * Ground truth: api -> core and core -> store are declared and pass; core
 * imports the external `yaml` package, which the vendor element claims. The
 * planted api -> store import (`routes.py` reading `db.py` directly) is
 * forbidden by the model and must surface as a `missing-relationship` error.
 * The standard-library imports (`json`, `typing`, `pathlib`) must NOT be
 * reported: the default instructions say to skip them, an unclaimed package
 * is deliberately silent in the gate, so the expectations pin them as
 * must-not observations.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

export default function python(exec: AgentExec, root: string): PipelineConfig {
  return {
    repositoryRoot: root,
    modelDir: path.join(root, 'arch'),
    // Deliberately no `instructions`: the shipped default is the thing under
    // evaluation. `roots` only bounds the listing to the fixture's sources.
    scan: [agentScan({ exec, roots: ['src'] })],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}
