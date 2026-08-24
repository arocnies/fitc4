/**
 * The same gate as `fitc4.config.mts`, plus the agent providers. Run it with
 * `fitc4 --config fitc4.agent.config.ts` (wired up here as
 * `npm run fitc4:agent`).
 *
 * A separate config on purpose: CI runs the deterministic gate, and these
 * providers shell out to your locally installed `claude` CLI (your login,
 * your billing). The validate providers are advisory: missing or logged out,
 * the run still passes with a visible `agent-unavailable` note. agentResolve
 * is fail-closed, though it makes zero calls in this example (see below).
 */

import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import {
  agentOwnershipAdvisor,
  agentResolve,
  agentSemanticReview,
  cached,
  claudeCli,
} from '@arocnies/fitc4/agent'

// Cheap model; `cached` makes reruns with unchanged inputs free and identical.
const agent = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  // agentResolve maps what sourceRoot cannot: imports of external packages
  // onto elements that own no files. This example has neither, so it makes
  // zero calls here; it is composed to show where it goes. Fail-closed where
  // it does run: a missing or logged-out CLI is an error, not a thinner run.
  resolve: [sourceRoot(), agentResolve({ exec: agent })],
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
