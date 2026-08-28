/**
 * Greenfield: a small, clean TypeScript project — evaluates `agentResolve`.
 *
 * The deterministic gate is the fixture's own `fitc4.config.mts`, loaded for
 * real so the eval also proves the config is valid. `agentResolve` is added
 * alongside the standard resolver, exactly as the docs compose it. Ground
 * truth: `stripe` unambiguously belongs to `shop.external.payments` (must be
 * mapped), while `@aws-sdk/client-s3` could be either of two object-storage
 * elements (must be left unmapped — abstention is the right answer). The
 * model also declares an `External packages` junk-drawer element, and both
 * answers must resist it: a payments SDK dumped there instead of on the
 * system it talks to is the measured live failure the default prompt now
 * steers against.
 */

import path from 'node:path'

import { resolveConfig, type PipelineConfig } from '@arocnies/fitc4'
import { agentResolve, type AgentExec } from '@arocnies/fitc4/agent'

export default async function greenfield(exec: AgentExec, root: string): Promise<PipelineConfig> {
  const base = await resolveConfig(path.join(root, 'fitc4.config.mts'))
  return {
    ...base,
    resolve: [
      ...base.resolve,
      agentResolve({
        exec,
        instructions:
          'The shop integrates managed third-party services; map each external package onto ' +
          'the managed-service element that implements it. Map only what the element catalog ' +
          'clearly identifies — when more than one element could plausibly own a package, ' +
          'leave it unmapped.',
      }),
    ],
  }
}

/**
 * The same fixture with NO mapping instructions: the shipped prompt alone.
 *
 * This angle exists because the base wiring is generous. Its instructions say
 * to map each package onto the managed service that implements it and to
 * leave a package alone when more than one element could own it, which is the
 * stripe mapping and the S3 abstention stated in prose. A user who writes no
 * instructions gets only `PROMPT`, whose driver-and-client sentence and
 * confidence rule have to carry both answers by themselves, over a catalog
 * that includes a junk drawer built to attract the wrong one.
 *
 * It shares the base expectations deliberately: same required outcome, less
 * help. A divergence here and a pass there localises the credit to the prose.
 */
export const angles = {
  'bare-resolve': async (exec: AgentExec, root: string): Promise<PipelineConfig> => {
    const base = await resolveConfig(path.join(root, 'fitc4.config.mts'))
    return { ...base, resolve: [...base.resolve, agentResolve({ exec })] }
  },

  /**
   * The one-sentence tier between the two: a domain fact a user would type
   * (what the managed-service elements ARE), with the mapping rule and the
   * abstention rule left entirely to the shipped prompt. Shares the base
   * expectations: same required mapping, same required abstention.
   */
  'user-hint': async (exec: AgentExec, root: string): Promise<PipelineConfig> => {
    const base = await resolveConfig(path.join(root, 'fitc4.config.mts'))
    return {
      ...base,
      resolve: [
        ...base.resolve,
        agentResolve({
          exec,
          instructions:
            'The shop runs on managed third-party services; the model catalogs them as ' +
            'managed-service elements.',
        }),
      ],
    }
  },
}
