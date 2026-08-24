/**
 * `@arocnies/fitc4/agent`: providers that shell out to local agent CLIs.
 *
 * A separate entry point on purpose: the core gate stays deterministic and
 * dependency-free, and nothing in `fitc4` imports this module. Composing an
 * agent provider into a phase is the user's explicit act, in their config file.
 *
 * The standing contract: agent findings are additive and carry the severity the
 * user chose (advisory by default), an unavailable CLI is a visible finding
 * rather than a failed build or a silent skip, and `cached` makes reruns with
 * unchanged inputs free and identical.
 */

export type { AgentExec, AgentReply, AgentRequest } from './exec.ts'
export { composeInput, extractJson } from './exec.ts'

export { claudeCli, DEFAULT_CLAUDE_MODEL, type ClaudeCliOptions } from './claude-cli.ts'
export { codexCli, type CodexCliOptions } from './codex-cli.ts'
export { cached, type CacheOptions } from './cache.ts'

export {
  assemblePack,
  buildGraph,
  codeFirstExcerpt,
  DEFAULT_PACK_BUDGET_BYTES,
  elementPack,
  fencedExcerpt,
  fileNeighborhood,
  PACK_HEADER,
  type AssembledPack,
  type CodeFirstExcerpt,
  type ContextGraph,
  type ElementFacts,
  type NeighborEdge,
  type PackSection,
} from './context-pack.ts'

export {
  agentScan,
  PROVIDER_ID as AGENT_SCAN_PROVIDER_ID,
  type AgentScanOptions,
} from './scan.ts'
export {
  agentResolve,
  PROVIDER_ID as AGENT_RESOLVE_PROVIDER_ID,
  type AgentResolveOptions,
} from './resolve.ts'
export {
  agentOwnershipAdvisor,
  PROVIDER_ID as AGENT_OWNERSHIP_ADVISOR_PROVIDER_ID,
  type OwnershipAdvisorOptions,
} from './ownership-advisor.ts'
export {
  agentSemanticReview,
  PROVIDER_ID as AGENT_SEMANTIC_REVIEW_PROVIDER_ID,
  type SemanticReviewOptions,
} from './semantic-review.ts'
export { draftDescriber, type DraftDescriberOptions } from './describe.ts'
