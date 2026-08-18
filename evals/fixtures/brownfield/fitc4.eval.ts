/**
 * Brownfield: a mid-size project carrying declared debt — evaluates the two
 * advisory validate providers on top of the full deterministic gate.
 *
 * The deterministic ground truth stands on its own (run the fixture without
 * any agent and the drift ledger, direction violation, and unowned-file
 * warning are all there): two exercised `#drift` edges, one stale one, one
 * genuine `relationship-direction` violation, and one unowned file. On top of
 * that, `agentSemanticReview` must flag `mono.core` (described as pure and
 * I/O-free, but `report.ts` writes files) and must NOT flag the honestly
 * described `mono.ui`; `agentOwnershipAdvisor` must suggest `mono.ui` for the
 * unowned `src/render-helpers.ts`, whose whole import neighborhood is UI.
 */

import path from 'node:path'

import { loadConfig, pipelineConfig, type PipelineConfig } from 'fitc4'
import { agentOwnershipAdvisor, agentSemanticReview, type AgentExec } from 'fitc4/agent'

export default function brownfield(exec: AgentExec, root: string): PipelineConfig {
  const base = pipelineConfig(loadConfig(path.join(root, 'fitc4.config.json')))
  return {
    ...base,
    validate: [
      ...base.validate,
      agentOwnershipAdvisor({ exec }),
      agentSemanticReview({ exec }),
    ],
  }
}
