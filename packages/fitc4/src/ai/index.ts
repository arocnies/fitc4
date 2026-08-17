/**
 * `fitc4/ai` — AI-assisted providers over local agent CLIs.
 *
 * A separate entry point on purpose: the core gate stays deterministic and
 * dependency-free, and nothing in `fitc4` imports this module. Composing an AI
 * provider into a phase is the user's explicit act, in their config file.
 *
 * The standing contract: AI findings are additive and carry the severity the
 * user chose (advisory by default), an unavailable CLI is a visible finding
 * rather than a failed build or a silent skip, and `cached` makes reruns with
 * unchanged inputs free and identical.
 */

export type { AiExec, AiReply, AiRequest } from './exec.ts'
export { composeInput, extractJson } from './exec.ts'

export { claudeCli, DEFAULT_CLAUDE_MODEL, type ClaudeCliOptions } from './claude-cli.ts'
export { codexCli, type CodexCliOptions } from './codex-cli.ts'
export { cached, type CacheOptions } from './cache.ts'

export {
  aiOwnershipAdvisor,
  PROVIDER_ID as AI_OWNERSHIP_ADVISOR_PROVIDER_ID,
  type OwnershipAdvisorOptions,
} from './ownership-advisor.ts'
export {
  aiSemanticReview,
  PROVIDER_ID as AI_SEMANTIC_REVIEW_PROVIDER_ID,
  type SemanticReviewOptions,
} from './semantic-review.ts'
