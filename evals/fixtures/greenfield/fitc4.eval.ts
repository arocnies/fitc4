/**
 * Greenfield: a small, clean TypeScript project — evaluates `agentResolve`.
 *
 * The deterministic gate is the fixture's own `fitc4.config.json`, loaded for
 * real so the eval also proves the config is valid. `agentResolve` is added
 * alongside the default resolver, exactly as the docs compose it. Ground
 * truth: `stripe` unambiguously belongs to `shop.external.payments` (must be
 * mapped), while `@aws-sdk/client-s3` could be either of two object-storage
 * elements (must be left unmapped — abstention is the right answer).
 */

import path from 'node:path'

import { loadConfig, pipelineConfig, type PipelineConfig } from 'fitc4'
import { agentResolve, type AgentExec } from 'fitc4/agent'

export default function greenfield(exec: AgentExec, root: string): PipelineConfig {
  const base = pipelineConfig(loadConfig(path.join(root, 'fitc4.config.json')))
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
