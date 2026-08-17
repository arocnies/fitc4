# Writing a provider

A provider is a plain async function. There is no registry, lifecycle, or discovery system: providers are composed into phase arrays, either in code through `runPipeline`, or in a `fitc4.config.ts` / `fitc4.config.js` whose default export the CLI loads. The pipeline runs

```
native LikeC4 validation → scan → resolve → validate → report
```

and each phase has one provider type, defined in [`packages/fitc4/src/types.ts`](../packages/fitc4/src/types.ts):

| Phase | Type | Receives | Returns |
|---|---|---|---|
| scan | `ScanProvider` | `ScanContext` — `repositoryRoot`, the `sources` prefixes declared in the model, `changedPaths` (always empty for now) | `Observation[]` — implementation facts |
| resolve | `ResolveProvider` | `ResolveContext` — the LikeC4 `model`, all `observations`, `repositoryRoot`, `sources` | `Association[]` — mappings from observations onto the model |
| validate | `ValidateProvider` | `ValidateContext` — `model`, `observations`, `associations`, `repositoryRoot`, `sources` | `Finding[]` — judgments with a severity |

A scan provider knows nothing about the model beyond the ownership prefixes; a resolve provider maps facts onto the model without judging them; a validate provider judges and never gathers. Deviating from that split works mechanically, but the standard providers assume it.

## The envelope and `data`

`Observation`, `Association`, and `Finding` are the envelope. Anything every provider must be able to rely on belongs in the envelope's named fields — `kind`, `subject`, `target`, `evidence`, `severity`, `candidates` — not in `data`. The core never interprets `data`; it only checks that it survives a JSON round trip (cycles, `undefined`, functions, `Map`, `NaN`, class instances are all rejected, and the rejection fails the provider). Providers may read each other's `data`, but a provider that does so owns the coupling: there is no schema negotiation, and nothing warns when the shape changes.

## The kind vocabulary

`Observation.kind` and `Ref.kind` are the one contract that crosses provider boundaries, named in [`packages/fitc4/src/kinds.ts`](../packages/fitc4/src/kinds.ts).

Standard observation kinds: `file` (a source file exists and is in scope for ownership), `dependency` (`subject` depends on `target`), `unresolved-dependency` (a dependency whose target could not be resolved), `scan-root` (a path the provider actually looked at — the coverage attestation).

Standard ref kinds: `element`, `relationship` (the model), `file`, `directory`, `module`, `symbol` (the repository), `observation`, `provider` (the pipeline). `symbol` is reserved: it is in the vocabulary so two providers that want it agree on its name, but nothing emits it yet.

The vocabulary is open — a provider may emit its own kinds, and two providers that understand each other's private kinds may cooperate. What the standard set buys is a default that works: emit these and the standard rules understand you. An observation kind outside the standard set is legal but unread by the standard rules, which report it at `info` severity (`unknown-observation-kind`) rather than passing silently.

The set is versioned with the package: adding a standard kind is a minor version, changing a kind's meaning is a major version.

## Ids

Emit natural keys — `file:src/index.ts`, `dependency:src/a.ts:12->./b.ts`. The core prefixes every id with the provider's composed id, so two providers cannot collide on the same natural key. Two consequences: an id must be unique within your own output (a duplicate fails the provider), and an `Association.observationId` must be the namespaced id as received in `context.observations`, not a rebuilt natural key — a rebuilt key points at nothing, and the core reports it (`orphaned-association`) instead of letting the association silently drop.

## Failure

A provider that throws becomes one `error` finding (`provider-failure`) attributed to that provider; the other providers still run. Output is staged and committed as a unit, so a provider that fails partway contributes nothing — half a result is a misleading one. Do not catch your own errors to return a partial result; throw, and let the attribution machinery report it.

## Never fail open

The property the whole tool exists for: a check that silently reports nothing is worse than no check, because it looks like success. Concretely — a scan provider that means `dependency` but emits `import` produces observations no rule reads, therefore zero findings and exit 0, indistinguishable from a genuinely clean repository. That is why unknown kinds are reported rather than skipped. When writing a provider, ask what its output looks like when its input is empty or malformed; if that case is indistinguishable from a clean run, it needs a finding.

## A complete `fitc4.config.ts`

A phase array present in the config replaces the defaults for that phase entirely — present replaces, absent defaults. There are no merge semantics; a config that extends a phase spreads the default entries back in explicitly, using the exported providers and their exported ids, so the composition is visible in the file that owns it.

```ts
import { defineConfig, defaultValidate, type Finding, type ValidateContext } from 'fitc4'

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
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // Present replaces: this array is the whole validate phase, so the default
  // rules come back in through the spread. Dropping the spread is how the
  // standard rules are deliberately replaced — the report's provider line
  // shows either way. scan and resolve are absent and keep their defaults.
  validate: [...defaultValidate, { id: PROVIDER_ID, run: importBudget }],
})
```

Discovery checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, then `fitc4.config.json` — in the working directory and its `.fitc4/`, then each ancestor. Two configs in one directory is an error, because whichever lost a tiebreak would be a silently ignored config. The module forms load as ES modules; a CommonJS package names its config `fitc4.config.mts`. `defaultResolve` is exported the same way. Scan has no array export because its provider is built from config values; rebuild it with `typescriptImports({ tsconfigPath, roots })` under `TYPESCRIPT_IMPORTS_PROVIDER_ID`. Every report names the providers that composed each phase, so a replaced phase is visible in the output, not only in the config.

The standard rules take per-rule severity overrides. `architectureRules()` with no options is what `defaultValidate` carries; it returns a ready `NamedProvider`, so tuning it is one line:

```ts
import { architectureRules } from 'fitc4'

// Once adoption is done, new unowned code should fail the gate — its
// dependencies are never boundary-checked while it stays unowned.
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

Any rule id from the rules table can be promoted or softened; the standard severities apply where no override is given.

## AI-assisted providers (`fitc4/ai`)

A separate entry point on purpose: nothing in `fitc4` imports it, the core gate stays deterministic, and composing an AI provider into a phase is an explicit act in your config file. The adapters shell out to **locally installed agent CLIs** — your own `claude` or `codex` install, login, and billing. FitC4 never holds an API key.

```ts
import { defineConfig, defaultValidate } from 'fitc4'
import { cached, claudeCli, aiOwnershipAdvisor, aiSemanticReview } from 'fitc4/ai'

const cheap = cached(claudeCli({ model: 'haiku' }))
const strong = cached(claudeCli({ model: 'sonnet' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  validate: [
    ...defaultValidate,
    aiOwnershipAdvisor({ exec: cheap }),
    aiSemanticReview({ exec: strong }),
  ],
})
```

**The standing contract.** AI findings are additive — nothing an AI says can suppress or rewrite a deterministic finding — and each provider's `severity` option says how load-bearing its judgment is (`info` for the advisor, `warning` for the review; advisory either way). Setting `severity: 'error'` is the explicit act of making that provider part of the gate. Nondeterminism is fine when it is chosen. An unavailable or logged-out CLI is one visible `ai-unavailable` finding — a `warning` behind an advisory provider, but an `error` behind a gating one, because a gate whose judge is absent must not pass. Truncated inputs escalate the same way, and so do mumbled verdicts: a reply that parses as JSON but does not match the requested schema is a failure, not a value, and a gating advisor whose reply skips files it was asked about fails rather than letting them pass unjudged.

**The exec layer.** `AiExec` is the one interface: `claudeCli()` runs `claude --print` isolated (no user settings, no MCP servers, and — by default — no tools, so the reply can only come from the prefilled context); `codexCli()` runs `codex exec` ephemeral with a read-only sandbox and schema-enforced JSON output. `agentic: true` on a request permits read-only exploration. A custom adapter is ~40 lines: implement `id` and `run`, return `{ ok, value }`.

**Determinism and cost.** `cached()` keys on everything the model saw — adapter id, prompt, context, schema — so a rerun with unchanged inputs replays the recorded reply, free and identical (default cache: `node_modules/.cache/fitc4-ai`). Both providers are trigger-driven: the advisor only runs when unowned files exist, the review only over elements with descriptions, so a clean steady-state run makes zero AI calls. Cheap model for extraction-shaped work, strong model for judgment, chosen per instance.

| Rule | Severity | Meaning |
|---|---|---|
| `ownership-suggestion` | the provider's `severity` (default info) | An unowned file, with the element the AI thinks should own it |
| `description-drift` | the provider's `severity` (default warning) | An element's implementation may not match its declared description |
| `ai-unavailable` | warning; error when the provider gates | The CLI failed, was missing or logged out, or replied off-schema; the provider's judgment is absent |
| `ai-truncated` | info; error when the provider gates | Inputs beyond a configured limit were not reviewed |
