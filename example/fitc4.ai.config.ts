/**
 * The same gate as `fitc4.config.json`, plus AI assistance — run it with:
 *
 *   npm run arch:ai
 *
 * Kept out of the default `check` on purpose: the deterministic gate is what
 * CI runs, and the AI providers are advisory enrichment you invoke when you
 * want a second opinion. They shell out to your locally installed `claude`
 * CLI (your login, your billing); if it is missing or logged out, the run
 * still passes with a visible `ai-unavailable` note.
 */

import { architectureRules, ARCHITECTURE_RULES_PROVIDER_ID, defineConfig } from 'fitc4'
import { aiOwnershipAdvisor, aiSemanticReview, cached, claudeCli } from 'fitc4/ai'

// Cheap model; `cached` makes reruns with unchanged inputs free and identical.
const ai = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // Present replaces the preset for the phase, so the standard rules are
  // rebuilt here alongside the AI providers. scan and resolve stay default.
  validate: [
    { id: ARCHITECTURE_RULES_PROVIDER_ID, run: architectureRules },
    // Suggests an owner for any file no element claims. Zero AI calls when
    // the repository is clean.
    aiOwnershipAdvisor({ exec: ai }),
    // Judges each described element's implementation against its description.
    aiSemanticReview({ exec: ai }),
  ],
})
