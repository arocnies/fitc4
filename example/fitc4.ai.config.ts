/**
 * The same gate as `fitc4.config.json`, plus AI assistance — run it with:
 *
 *   npm run fitc4:ai
 *
 * Kept out of the default `check` on purpose: the deterministic gate is what
 * CI runs, and the AI providers are advisory enrichment you invoke when you
 * want a second opinion. They shell out to your locally installed `claude`
 * CLI (your login, your billing); if it is missing or logged out, the run
 * still passes with a visible `ai-unavailable` note.
 */

import { defineConfig, defaultValidate } from 'fitc4'
import { aiOwnershipAdvisor, aiSemanticReview, cached, claudeCli } from 'fitc4/ai'

// Cheap model; `cached` makes reruns with unchanged inputs free and identical.
const ai = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // Present replaces the defaults for the phase, so the standard rules come
  // back in through the spread. scan and resolve stay default.
  validate: [
    ...defaultValidate,
    // Suggests an owner for any file no element claims. Zero AI calls when
    // the repository is clean. `severity: 'error'` would make either provider
    // part of the gate instead of advisory.
    aiOwnershipAdvisor({ exec: ai }),
    // Judges each described element's implementation against its description.
    // Unlike the advisor, this calls the CLI once per described element even
    // when the repository is clean (two calls here); `cached` makes every
    // rerun with unchanged files free.
    aiSemanticReview({ exec: ai }),
  ],
})
