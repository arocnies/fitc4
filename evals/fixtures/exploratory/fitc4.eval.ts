/**
 * Exploratory: a model domain spread across many files — evaluates `agentScan`
 * in exploratory (`agentic: true`) mode, the least predictable of its modes.
 *
 * The implementation is a directory of markdown runbooks, one per service
 * under `docs/runbooks/<name>/`, and no single file tells the whole story:
 * each runbook documents the services its own service touches, so the facts
 * only fall out of reading all of them. There is no `focus` option here on
 * purpose — the request carries the instructions plus a file listing, and in
 * live mode the agent walks the repository read-only to earn its
 * observations and its `examined[]` attestation. (The stub ignores `agentic`,
 * so stub mode still answers from `replies.json`.)
 *
 * Each service's runbook file stands in for the service wherever a fact needs
 * a file, and from there nothing is agent-specific: the stock `source-root`
 * resolver and `architecture-rules` judge the runbook-documented edges exactly
 * as they judge imports. Ground truth: gateway → worker, worker → store, and
 * worker → alerts are declared and pass; the alerts runbook documents a
 * fallback that queries the store directly, which the model forbids, so
 * alerts → store must surface as a `missing-relationship` error.
 */

import path from 'node:path'

import { architectureRules, sourceRoot, type PipelineConfig } from '@arocnies/fitc4'
import { agentScan, type AgentExec } from '@arocnies/fitc4/agent'

/**
 * The two-sentence tier: where the runbooks live and that they document
 * reliances — the two facts not written down in any one file. Which lines
 * count as a dependency, what vocabulary to answer in, and the instruction to
 * read all of them are the tool's and the model's job here.
 */
export const USER_HINT =
  'Each directory docs/runbooks/<name>/ holds the operational runbook of service <name>. The ' +
  'runbooks document which other services each service relies on.'

export const INSTRUCTIONS =
  'Each directory docs/runbooks/<name>/ holds the operational runbook of service <name>, and ' +
  'the file docs/runbooks/<name>/runbook.md stands in for the service wherever a fact needs a ' +
  'file. Read every runbook — the dependencies are spread across them and no single file tells ' +
  'the whole story. Emit: ' +
  "(1) one observation of kind 'runbook' per service, with subject " +
  "{ kind: 'runbook', id: <name> }; " +
  '(2) whenever a runbook step for service A calls, queries, writes to, or otherwise relies on ' +
  "another service B, one observation of kind 'dependency' with subject " +
  "{ kind: 'file', id: 'docs/runbooks/A/runbook.md' } and target " +
  "{ kind: 'file', id: 'docs/runbooks/B/runbook.md' }, citing the runbook and the line " +
  'documenting the reliance as evidence.'

function exploratoryConfig(exec: AgentExec, root: string, instructions?: string): PipelineConfig {
  return {
    repositoryRoot: root,
    modelDir: path.join(root, 'arch'),
    scan: [
      agentScan({
        exec,
        id: 'runbooks',
        roots: ['docs'],
        // Deliberately no `focus`: the request prefills only the instructions
        // and the file listing, and live mode explores read-only
        // (`agentic: true`) to find what the runbooks actually say.
        ...(instructions === undefined ? {} : { instructions }),
      }),
    ],
    resolve: [sourceRoot()],
    validate: [architectureRules()],
  }
}

export default function exploratory(exec: AgentExec, root: string): PipelineConfig {
  return exploratoryConfig(exec, root, INSTRUCTIONS)
}

/**
 * The near-zero tier over the same runbooks. `default-prompt` is the floor:
 * the shipped import scan exploring markdown that contains no imports, worth
 * pinning precisely because its failure mode is the quiet green — every
 * runbook is owned by its own element, so nothing fires and nothing is
 * checked. `user-hint` is the two sentences above; the ideal reply speaks
 * service names and the resolver carries them onto the elements.
 */
export const angles = {
  'default-prompt': (exec: AgentExec, root: string): PipelineConfig =>
    exploratoryConfig(exec, root),
  'user-hint': (exec: AgentExec, root: string): PipelineConfig =>
    exploratoryConfig(exec, root, USER_HINT),
}
