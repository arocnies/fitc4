/**
 * The same gate as `fitc4.config.mts`, plus two agent providers in validate.
 * Run it with `fitc4 --config fitc4.agent.config.ts` (wired up here as
 * `npm run fitc4:agent`).
 *
 * A separate config on purpose: CI runs the deterministic gate, and these
 * providers shell out to your locally installed `claude` CLI (your login,
 * your billing). If it is missing or logged out, the run still passes with a
 * visible `agent-unavailable` note.
 */

import { architectureRules, defineConfig, sourceRoot, typescriptImports } from 'fitc4'
import { agentOwnershipAdvisor, agentSemanticReview, cached, claudeCli } from 'fitc4/agent'

// Cheap model; `cached` makes reruns with unchanged inputs free and identical.
const agent = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [
    architectureRules(),
    // Suggests an owner for any file no element claims. Zero agent calls
    // when the repository is clean.
    agentOwnershipAdvisor({ exec: agent }),
    // Judges each described element's implementation against its description,
    // one call per element even when clean. `severity: 'error'` would make
    // either provider part of the gate instead of advisory.
    agentSemanticReview({ exec: agent }),
  ],
})
