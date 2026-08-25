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

import { architectureRules, importScan, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
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

/**
 * Two more wirings over the same Python project, because "which scanner" is
 * the first real decision `fitc4 init` makes for a non-TypeScript repository
 * and the suite had no measurement of the answer.
 *
 * `import-scan` swaps the agent for `importScan`, the deterministic
 * multi-language crawler `init` scaffolds whenever a repository holds source
 * in a language it reads (Python among them). Same roots as the agent scan,
 * so the scanner is the only variable. It has its own expectations because
 * the two attest differently: `agentScan` reports a `scan-root` per file it
 * read, `importScan` reports one for the root it walked plus a `file` per
 * file found. Everything downstream should be identical, planted violation
 * included, at zero agent cost, and the standard-library silence is pinned
 * here too: the deterministic crawler must be as quiet about `json`,
 * `typing`, and `pathlib` as the instructions tell the agent to be.
 *
 * `mixed` runs both scanners over the same tree, the composition the docs
 * recommend for a repository whose import backbone a parser can read but
 * whose other domains it cannot. What it pins is that the overlap is
 * harmless: observations are namespaced per provider, so the same import
 * arrives twice, while findings are keyed by the elements involved, so the
 * planted violation is still ONE error carrying both scanners' citations. A
 * config that mixes scanners must not double-report.
 */
export const angles = {
  'import-scan': (_exec: AgentExec, root: string): PipelineConfig => ({
    repositoryRoot: root,
    modelDir: path.join(root, 'arch'),
    scan: [importScan({ roots: ['src'] })],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }),

  mixed: (exec: AgentExec, root: string): PipelineConfig => ({
    repositoryRoot: root,
    modelDir: path.join(root, 'arch'),
    scan: [importScan({ roots: ['src'] }), agentScan({ exec, roots: ['src'] })],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }),
}
