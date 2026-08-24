# Writing a provider

A provider is a plain async function. There is no registry, lifecycle, or discovery system. You compose providers into phase arrays, either in code through `runPipeline`, or in a `fitc4.config.ts` / `fitc4.config.js` whose default export the CLI loads. The pipeline runs

```
native LikeC4 validation → scan → resolve → validate → report
```

and each phase has one provider type, defined in [`packages/fitc4/src/types.ts`](../packages/fitc4/src/types.ts):

| Phase | Type | Receives | Returns |
|---|---|---|---|
| scan | `ScanProvider` | `ScanContext` with `repositoryRoot` | `Observation[]`, implementation facts |
| resolve | `ResolveProvider` | `ResolveContext` with the LikeC4 `model`, all `observations`, `repositoryRoot` | `Association[]`, mappings from observations onto the model |
| validate | `ValidateProvider` | `ValidateContext` with `model`, `observations`, `associations`, `repositoryRoot` | `Finding[]`, judgments with a severity |

A scan provider observes the repository and knows nothing about the model. A resolve provider maps facts onto the model without judging them. A validate provider judges and never gathers. Deviating from that split works mechanically, but the standard providers assume it.

## The envelope and `data`

`Observation`, `Association`, and `Finding` are the envelope. Anything every provider must be able to rely on belongs in the envelope's named fields: `kind`, `subject`, `target`, `evidence`, `severity`, `candidates`. Not in `data`. The core never interprets `data`; it only checks that it survives a JSON round trip (cycles, `undefined`, functions, `Map`, `NaN`, class instances are all rejected, and the rejection fails the provider). Providers may read each other's `data`, but a provider that does so owns the coupling. There is no schema negotiation, and nothing warns when the shape changes.

## The kind vocabulary

`Observation.kind` and `Ref.kind` are the one contract that crosses provider boundaries, named in [`packages/fitc4/src/kinds.ts`](../packages/fitc4/src/kinds.ts).

Standard observation kinds: `file` (a source file exists and is in scope for ownership), `dependency` (`subject` depends on `target`), `unresolved-dependency` (a dependency whose target could not be resolved), `scan-root` (a path the provider actually looked at, the coverage attestation).

Standard ref kinds: `element`, `relationship` (the model), `file`, `directory`, `module`, `symbol` (the repository), `observation`, `provider` (the pipeline). `symbol` is reserved. It is in the vocabulary so two providers that want it agree on its name, but nothing emits it yet.

Two pieces of model metadata change what the standard resolve and validate providers do with these kinds, and a provider author should know both:

- **Package claims.** A `dependency` observation whose `target` is a `module` ref is not automatically outside the model. If an element claims that package via `packages` metadata, `source-root` resolves the association onto the claiming element, and the standard relationship rules judge it like any file-to-file crossing. A scan provider that emits `module` targets is therefore feeding the boundary check, not just the `unresolved-import` nudge.
- **Drift tags.** A relationship tagged with the drift tag (default `drift`, configurable via `architectureRules({ driftTag })`) is a declared relationship, so associations covered by it count as declared. On top of that, `architecture-rules` emits one `drift-relationship` (exercised) or `unused-drift` (unexercised) finding per drift edge, and the report derives its burn-down line from those findings. A validate provider replacing the standard rules takes on that behavior too.

The vocabulary is open. A provider may emit its own kinds, and two providers that understand each other's private kinds may cooperate. What the standard set buys is a default that works: emit these and the standard rules understand you. An observation kind outside the standard set is legal but unread by the standard rules, which report it at `info` severity (`unknown-observation-kind`) rather than passing silently.

The set is versioned with the package: adding a standard kind is a minor version, changing a kind's meaning is a major version.

## Ids

Emit natural keys like `file:src/index.ts` or `dependency:src/a.ts:12->./b.ts`. The core prefixes every id with the provider's composed id, so two providers cannot collide on the same natural key. Two consequences. An id must be unique within your own output, since a duplicate fails the provider. And an `Association.observationId` must be the namespaced id as received in `context.observations`, not a rebuilt natural key. A rebuilt key points at nothing, and the core reports it (`orphaned-association`) instead of letting the association silently drop.

## Failure

A provider that throws becomes one `error` finding (`provider-failure`) attributed to that provider; the other providers still run. Output is staged and committed as a unit, so a provider that fails partway contributes nothing. Half a result is a misleading one. Do not catch your own errors to return a partial result; throw, and let the attribution machinery report it.

## Never fail open

The property the whole tool exists for: a check that silently reports nothing is worse than no check, because it looks like success. Take a scan provider that means `dependency` but emits `import`. It produces observations no rule reads, therefore zero findings and exit 0, indistinguishable from a genuinely clean repository. That is why unknown kinds are reported rather than skipped. When writing a provider, ask what its output looks like when its input is empty or malformed; if that case is indistinguishable from a clean run, it needs a finding.

## A complete `fitc4.config.ts`

The three phase arrays are required and explicit. What runs is what the file names: there are no default phases, no merge semantics, and nothing composed in behind the file. Extending the gate means writing the standard providers and yours in one visible array.

```ts
import {
  architectureRules,
  defineConfig,
  sourceRoot,
  typescriptImports,
  type Finding,
  type ValidateContext,
} from '@arocnies/fitc4'

const PROVIDER_ID = 'import-budget'
const BUDGET = 20

/** Flag any file with more dependencies than the budget allows. */
async function importBudget(context: ValidateContext): Promise<Finding[]> {
  const counts = new Map<string, number>()
  for (const observation of context.observations) {
    if (observation.kind !== 'dependency') continue
    const file = observation.subject?.id
    if (file !== undefined) counts.set(file, (counts.get(file) ?? 0) + 1)
  }

  return [...counts]
    .filter(([, count]) => count > BUDGET)
    .map(([file, count]) => ({
      id: `import-budget:${file}`,
      ruleId: 'import-budget',
      severity: 'warning' as const,
      description: `${file} has ${count} dependencies; the budget is ${BUDGET}.`,
      subject: { kind: 'file', id: file },
      provider: PROVIDER_ID,
    }))
}

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  // This array is the whole validate phase. Dropping architectureRules() is
  // how the standard rules are deliberately replaced; the report's provider
  // line shows either way.
  validate: [architectureRules(), { id: PROVIDER_ID, run: importBudget }],
})
```

Discovery checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, in the working directory and its `.fitc4/`, then each ancestor. Two configs in one directory is an error, because whichever lost a tiebreak would be a silently ignored config. Configs load as ES modules; a CommonJS package names its config `fitc4.config.mts`. Every report names the providers that composed each phase, so a changed phase is visible in the output, not only in the config.

The standard rules take per-rule severity overrides. `architectureRules()` returns a ready `NamedProvider`, so tuning it is one line:

```ts
import { architectureRules } from '@arocnies/fitc4'

// Once adoption is done, new unowned code should fail the gate. Its
// dependencies are never boundary-checked while it stays unowned.
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

Any rule id from the rules table can be promoted or softened, and the standard severities apply where no override is given. Tolerated drift is tuned the same way. `{ 'drift-relationship': 'error' }` forbids it outright, and `{ 'unused-drift': 'error' }` fails the build until a drift edge the code no longer exercises is deleted. `architectureRules({ driftTag })` renames the tag itself.

## Agent providers (`@arocnies/fitc4/agent`)

A separate entry point on purpose: nothing in `fitc4` imports it, the core gate stays deterministic, and composing an agent provider into a phase is an explicit act in your config file. The adapters shell out to **locally installed agent CLIs**, meaning your own `claude` or `codex` install, login, and billing. FitC4 never holds an API key.

`@arocnies/fitc4/agent` ships two tiers. This section is the standing contract for the **advisory validate providers** (`agentOwnershipAdvisor`, `agentSemanticReview`) and the exec layer they all share. The **fail-closed scan and resolve providers** (`agentScan`, `agentResolve`) are load-bearing. An absent scanner or resolver must not look like a clean run, so they throw into `provider-failure` instead of degrading. They are documented per provider in [`agent-providers.md`](agent-providers.md).

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import { cached, claudeCli, agentOwnershipAdvisor, agentSemanticReview } from '@arocnies/fitc4/agent'

const cheap = cached(claudeCli({ model: 'haiku' }))
const strong = cached(claudeCli({ model: 'sonnet' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [
    architectureRules(),
    agentOwnershipAdvisor({ exec: cheap }),
    agentSemanticReview({ exec: strong }),
  ],
})
```

**The standing contract.** Agent findings are additive. Nothing an agent says can suppress or rewrite a deterministic finding. Each provider's `severity` option says how load-bearing its judgment is (`info` for the advisor, `warning` for the review; advisory either way). Setting `severity: 'error'` is the explicit act of making that provider part of the gate. Nondeterminism is fine when it is chosen. An unavailable or logged-out CLI is one visible `agent-unavailable` finding, a `warning` behind an advisory provider but an `error` behind a gating one, because a gate whose judge is absent must not pass. Truncated inputs escalate the same way, and so do mumbled verdicts. A reply that parses as JSON but does not match the requested schema is a failure, not a value, and a gating advisor whose reply skips files it was asked about fails rather than letting them pass unjudged.

**The prefilled context.** Both providers prefill from the shared context-pack layer ([`agent-providers.md`](agent-providers.md#context-packs)). The advisor sends each unowned file's import neighborhood, with every neighbor annotated by its owning element, ahead of a 1,000-char code-first excerpt. The review sends each element's facts (description, declared relationships, observed resolved edges, the complete owned-file list with excerpted files marked) ahead of code-first excerpts. Every pack opens with a `context-pack v1` header and announces anything a cap or byte budget drops. The review's files beyond `maxFilesPerElement` were once a silent drop; now they are announced in the context and attested as `agent-truncated` findings.

**The exec layer.** `AgentExec` is the one interface. `claudeCli()` runs `claude --print` isolated: no user settings, no MCP servers, and by default no tools, so the reply can only come from the prefilled context. `codexCli()` runs `codex exec` ephemeral with a read-only sandbox and schema-enforced JSON output. `agentic: true` on a request permits read-only exploration. A custom adapter is ~40 lines: implement `id` and `run`, return `{ ok, value }`. An optional `fingerprint` names any fixed prompt or flag the request itself does not carry, so the cache key covers it.

**Determinism and cost.** `cached()` keys on everything the model saw: adapter id and fingerprint, prompt, context, schema. It validates a hit exactly like a live reply, so a corrupted or off-schema entry is a miss rather than a value. A rerun with unchanged inputs replays the recorded reply, free and identical (default cache: `node_modules/.cache/fitc4-agent`). Both providers are trigger-driven. The advisor only runs when unowned files exist, the review only over elements with a real description, so a clean steady-state run makes zero agent calls. A placeholder counts as no description: the review skips any element whose description is absent, empty, or starts with `TODO`, the same convention `missingDescriptions()` uses, both reading one predicate in the core model vocabulary rather than repeating the test. Otherwise a fresh project paid for a warning that the scaffold's own `TODO: what is this component responsible for?` states no responsibility, and a freshly drafted one paid for it up to `maxElements` times per run. A known-absent description is already counted deterministically; a model does not need to rediscover it. Cheap model for extraction-shaped work, strong model for judgment, chosen per instance.

| Rule | Severity | Meaning |
|---|---|---|
| `ownership-suggestion` | the provider's `severity` (default info) | An unowned file, with the element the agent thinks should own it |
| `description-drift` | the provider's `severity` (default warning) | An element's implementation may not match its declared description |
| `agent-unavailable` | warning; error when the provider gates | The CLI failed, was missing or logged out, or replied off-schema; the provider's judgment is absent |
| `agent-truncated` | info; error when the provider gates | Inputs beyond a configured limit were not reviewed |
