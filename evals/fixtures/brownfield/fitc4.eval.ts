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

import { resolveConfig, type PipelineConfig } from '@arocnies/fitc4'
import {
  agentOwnershipAdvisor,
  agentResolve,
  agentSemanticReview,
  type AgentExec,
} from '@arocnies/fitc4/agent'

export default async function brownfield(exec: AgentExec, root: string): Promise<PipelineConfig> {
  const base = await resolveConfig(path.join(root, 'fitc4.config.mts'))
  return {
    ...base,
    validate: [
      ...base.validate,
      agentOwnershipAdvisor({ exec }),
      agentSemanticReview({ exec }),
    ],
  }
}

/**
 * The same brownfield project with NO agent at all: the free baseline.
 *
 * Every other fixture answers "what do the agents add"; none answered "what
 * do you get without paying for one", and that is the first question a
 * skeptical adopter asks. This angle runs the fixture's own config verbatim,
 * which is exactly what `fitc4 init` scaffolds without `--agent`, and pins
 * the five deterministic findings as the complete set: the direction
 * violation, both exercised drift edges, the stale drift edge to delete, and
 * the unowned file. What disappears is judgment, not detection. The unowned
 * file is still reported, just without a suggestion of where it belongs, and
 * the description that contradicts its code passes unremarked, because no
 * deterministic rule can read prose against behaviour.
 *
 * It runs zero agent calls, so it is free in every mode and its row is
 * identical in stub and live runs.
 */
export const angles = {
  /**
   * The whole default scaffold, exactly the provider mix `fitc4 init --agent`
   * writes: the deterministic scanner and resolver, `agentResolve` behind
   * them, and both advisory validators. Nowhere else in the suite do all four
   * agent providers run in one pipeline, which is the configuration most
   * users will actually have.
   *
   * The base wiring leaves `agentResolve` out, so its one candidate here has
   * never been asked: `mono.core` imports `node:fs`, and no element in this
   * model stands for the Node standard library. The only right answer is to
   * leave it unmapped, which the expectations pin as a named regression. It
   * is the abstention case with no junk drawer available to hide in, so a
   * model that dislikes returning nothing has to invent an owner to fail.
   */
  'default-agent': async (exec: AgentExec, root: string): Promise<PipelineConfig> => {
    const base = await resolveConfig(path.join(root, 'fitc4.config.mts'))
    return {
      ...base,
      resolve: [...base.resolve, agentResolve({ exec })],
      validate: [...base.validate, agentOwnershipAdvisor({ exec }), agentSemanticReview({ exec })],
    }
  },

  deterministic: async (_exec: AgentExec, root: string): Promise<PipelineConfig> =>
    await resolveConfig(path.join(root, 'fitc4.config.mts')),
}
