# Agent scan and resolve providers

Two providers from `@arocnies/fitc4/agent` extend the gate to cases the deterministic providers cannot reach, under the same fail-closed discipline: `agentScan` observes model domains no parser covers, and `agentResolve` maps leftover observations onto model elements no `sources` prefix can claim. Both are prototyping tools first. See [Cost and nondeterminism](#cost-and-nondeterminism). [`providers.md`](providers.md) covers the provider contract they implement, the shared exec layer, and the *advisory* validate providers (`agentOwnershipAdvisor`, `agentSemanticReview`). [Context packs](#context-packs) below describes the layer they all prefill from.

## Context packs

The pipeline knows far more than early versions of these providers sent: which files import which, who owns each neighbor, what each element declares and owns. The shared context-pack module (`buildGraph`, `fileNeighborhood`, `elementPack`, code-first excerpts, and a byte-budgeted assembler, all exported from `@arocnies/fitc4/agent`) turns that knowledge into deterministic prefilled context. These are pure functions over what a provider already receives, with no persistence and no I/O beyond bounded excerpt reads.

What each provider prefills:

- **`agentOwnershipAdvisor`** prefills, per unowned file, its import *neighborhood* (what it imports and what imports it, each neighbor annotated with its owning element or `unowned`; module imports annotated with their claiming element or `unclaimed`) ahead of a short code-first excerpt (default 1,000 chars). The neighborhood is the fact ownership turns on, so the excerpt stays small.
- **`agentSemanticReview`** prefills, per element, its *facts* first: description, declared relationships, observed resolved element edges, and the **complete** owned-file list with the excerpted files marked. Code-first excerpts follow. The model knows what exists even when a file is not excerpted.
- **`agentScan` with `focus`** prefills code-first excerpts of the matched files themselves. See [Focused one-shot scans](#focused-one-shot-scans).
- **`agentResolve`** prefills the element catalog plus per-decision candidate lines. Its context is a purpose-built listing, not a pack; see below.

The rules every pack obeys:

- **A versioned header.** Every pack starts with a `context-pack v1` line, so the format's semantics are explicit in the `cached()` key. A change to what a pack means bumps the version instead of replaying replies recorded against the old shape.
- **Truncation is always announced.** The assembler enforces a byte budget (48 KB by default) and writes an inline `NOTE: N <what> beyond budget not shown` whenever a count cap or the budget drops anything, so the model knows its view is partial. The validate providers also attest the same drops as `agent-truncated` findings, at `error` severity when the provider gates.
- **Code-first excerpts.** Excerpts deterministically skip a file's leading run of blank lines and C-family comments (never `#` lines, so markdown and YAML survive) and announce the skip inline (`[code-first: skipped N leading comment lines]`). File heads in this repository measured 53–69% comment; the same budget now buys mostly code.

## The `agent-scan` provider

`agentScan` is a scan provider driven by prose instead of a parser. The TypeScript scanner sees imports; it cannot see that `docker-compose.yml` wires one service to another, that a runbook names a component, or that an OpenAPI file declares a dependency between systems. `agentScan` lets a user enforce those model domains anyway: describe in prose what to observe, and the agent explores the repository read-only and reports standard `Observation`s that feed the same deterministic resolve and validate phases as any other scanner's.

This is the prototyping story for new model domains: an agent (human or otherwise) writes instructions, the deterministic rules judge whatever comes back, and a domain that proves its worth graduates to a purpose-built deterministic provider.

### How it works

- **Deterministic prefilled context.** The provider enumerates the files under `roots` (default: the repository root; bounded by `maxFiles`, default 300) and prefills the request with that listing plus the user's instructions. If the listing is truncated, the context says so. The model must know its map is partial. Because the context is a pure function of the repository and the options, the request composes with `cached()` unchanged: a rerun with unchanged inputs replays the recorded reply, free and identical.
- **Read-only exploration.** The request sets `agentic: true`, so the exec layer permits read-only repository access (`claude` gets `Read,Grep,Glob`; `codex` runs in a read-only sandbox). The reply must still come back as a single JSON value matching the reply schema. `codexCli` satisfies OpenAI strict-mode schema rules on its own, so providers keep writing plain schemas. It marks every object key required, rewrites optionals as nullable, and strips their explicit nulls back out of the reply.
- **Standard observations out.** Replies carry observations (`kind`, `subject`, optional `target`, optional `evidence`) plus a required `examined: string[]`, the files the model actually read. Each examined path becomes a standard `scan-root` observation: the coverage attestation the rules use to know what the code sample was. Observation kinds outside the standard set are legal; the `unknown-observation-kind` rule reports them at `info` rather than dropping them.

### Focused one-shot scans

`focus: string[]` switches the provider from exploring to prefilling. The globs match over the enumerated listing (`*` within a path segment, `**` across segments; a bare path matches itself or its directory subtree, the same prefix semantics as `sources`). The provider embeds the matched files as code-first excerpts (`excerptChars`, default 4,000) and drops `agentic` from the request entirely. What is left is a one-shot call answered from the context alone.

```ts
agentScan({
  exec,
  id: 'compose',
  roots: ['deploy'],
  focus: ['deploy/docker-compose*.yml'],
  instructions: 'Emit one dependency observation per service-to-service link.',
})
```

Two things follow from prefilling:

- **The cache key covers content.** In agentic mode the model may read file *contents* the listing does not carry, so an edit that changes no listed path can replay a stale cached reply. With `focus` the contents are in the request, so they are in the `cached()` key, and an edit to a focused file invalidates the recorded reply. Use `focus` once you know which files matter; it is the honest cache story.
- **Truncation is announced, absence is failure.** Matches beyond `maxFiles` or the pack's byte budget are announced inline (the one-shot model genuinely cannot see an unexcerpted file, and it must know that). A focus that matches nothing throws. A scan of zero files must not look like a clean domain.

Without `focus`, behavior is unchanged: listing plus `agentic: true` exploration.

### The fail-closed contract

`agentScan` is deliberately stricter than the agent validate providers. Those are advisory enrichment. Every deterministic finding still stands when they degrade to an `agent-unavailable` warning. A scanner is load-bearing: its observations *are* the coverage the rules judge, so an absent scanner must never look like a clean scan. Concretely, each of these **throws**, and the pipeline reports one `provider-failure` error finding attributed to the provider:

- the exec fails (missing CLI, logged out, timeout, non-zero exit);
- the reply is off-schema, since parsing is not the same as conforming;
- `examined` is empty, because a scan that read nothing observed nothing, and zero observations must not read as a clean domain;
- any path in `subject`/`target`/`evidence`/`examined` is absolute, escapes the repository root, or does not exist on disk. A hallucinated path is a claim about code that is not there; it fails the run visibly rather than being silently dropped, because dropping it would let the rest of the reply pass as trustworthy.

A failed provider contributes nothing, not even a half-scan. The other providers still run.

### A worked config

`npx fitc4 init --agent claude` (or `codex`) scaffolds a `fitc4.config.mts` around one shared cached exec, declared as the config's `agent` so `draft --describe` works immediately, and composes the agent providers into the phases they extend: `agentResolve` into resolve, the two advisory providers into validate, each with its cost commented beside it. The consequence is stated in the file: `agentResolve` is fail-closed, so every plain `npx fitc4`, the command the scaffolded `AGENTS.md` tells every coding agent to run before handing off, calls the CLI, and CI without a login hits a `provider-failure` error. A team whose CI carries no login splits the configs: a deterministic discovery config for CI, and the agent-composed one in a non-discovery filename run with `--config`; `example/fitc4.agent.config.ts` in the repository is that pattern. `agentScan` alone is never scaffolded: a fail-closed scanner driven by placeholder instructions is worse than no scanner, so it waits for your own prose.

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import { agentScan, cached, claudeCli, codexCli } from '@arocnies/fitc4/agent'

const exec = cached(claudeCli({ model: 'sonnet' }))
// Or the Codex CLI; gpt-5.6-luna also measured perfect across the eval suite:
// const exec = cached(codexCli({ model: 'gpt-5.6-luna' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [
    typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] }),
    agentScan({
      exec,
      id: 'compose',
      roots: ['deploy'],
      instructions:
        'Read docker-compose.yml and emit one dependency observation for each ' +
        'service-to-service link (depends_on, links, and connection strings in ' +
        'environment). Subject and target are refs of kind "service" named after ' +
        'the compose service. Cite the file and line as evidence.',
    }),
    agentScan({
      exec,
      id: 'docs',
      roots: ['docs'],
      instructions:
        'For every markdown file that names a source file, emit a dependency ' +
        'observation from the doc (kind "file") to that source file (kind "file").',
    }),
  ],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
})
```

Two instances coexist because `id` suffixes the provider id (`agent-scan:compose`, `agent-scan:docs`). The pipeline namespaces every observation id with the provider id it was composed under, so distinct suffixes keep two instances' attestations from colliding.

## The `agent-resolve` provider

`agentResolve` is a resolve provider for the observations the deterministic resolvers cannot map, meaning anything whose target is not a file under a `sources` prefix: dependencies on external packages, unresolvable specifiers, implied links. This is what makes description-only "pure thought" elements reachable by the gate. An external system or a managed queue has no source files to own, so no code edge ever resolves to it and nothing the code does to it is ever checked. `agentResolve` reads the element catalog (id, title, description, ownership) and the leftover observations, and proposes `resolved` associations. The standard relationship rules then judge those exactly like a deterministic edge. Undeclared crossings become `missing-relationship` errors, declared ones pass.

It is used **alongside** the default resolver, never instead of it:

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import { agentResolve, cached, claudeCli } from '@arocnies/fitc4/agent'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [
    sourceRoot(),
    agentResolve({
      exec: cached(claudeCli({ model: 'sonnet' })),
      instructions:
        'Requests to payments.internal and imports of the stripe SDK belong to the ' +
        'payments-gateway element. Message-broker clients belong to the queue element.',
    }),
  ],
  validate: [architectureRules()],
})
```

### The worked example

Say the model declares a description-only `demo.external.payments` ('Third-party payments API') and the code contains `import Stripe from 'stripe'` in a file owned by `demo.app.core`. The TypeScript scanner emits a `dependency` observation with a module target; `source-root` can only mark it `unresolved`, since an external package lives under no `sources` prefix. `agentResolve` sends the decision (with the element catalog) to the model, gets back `{ candidateId: 'demo.app.core=>stripe', elementId: 'demo.external.payments' }`, and emits a `resolved` association `demo.app.core → demo.external.payments` per underlying import site. If the model declares that relationship, the run passes; if not, the standard rules report `missing-relationship`. An edge that previously escaped the gate entirely is now judged by it.

### Leftover candidates are decisions, not import sites

`agentResolve` considers only the observations `source-root` cannot map, recomputed per run from the same inputs it reads (providers recompute rather than share state by design):

- `unresolved-dependency` observations, plus `dependency` observations whose target is a module or external specifier. Dependencies with repository-file targets never qualify, because those are `source-root`'s job, and neither do external dependencies whose package an element claims via `packages` metadata, which `source-root` already maps deterministically.
- only where the subject file has exactly one owning element (longest `sources` prefix, mirroring `source-root`). Without an unambiguous owner there is no source end for a judgeable association.

Those observations then collapse into distinct **decisions**: one candidate per (owning element, package-or-specifier) pair. Twelve imports of `stripe` and `stripe/webhooks` from files owned by one element are one question, asked once. Each decision carries a stable `candidateId` (`owner=>package`), its site count, and the site locations. The reply maps `candidateId → elementId`, and an accepted mapping fans back out to one association per underlying observation, so the standard rules still judge every import site. Resolvable module targets key on their package (via `packageNameOf`); unresolvable specifiers key on themselves.

Decisions beyond `maxObservations` (default 100, and it counts decisions) are announced as truncated in the context and stay unmapped. That is not a failure. They remain visible through the existing rules, namely `unresolved-import` and the absence of a declared edge. The reply may likewise map zero, some, or all candidates. An omitted candidate is a legitimate "I don't know" and keeps its deterministic `unresolved` association.

### The fail-closed contract

Same discipline as `agentScan`, same rationale stated the other way around: a resolver that silently fails produces fewer associations, which means fewer checks, which looks like a clean run. That is the exact fail-open the project exists to prevent. Each of these **throws**, becoming one `provider-failure` error finding:

- the exec fails or the reply is off-schema, including a reply keyed on the old per-observation shape, which a stale cache entry or custom adapter might still speak;
- the reply names a `candidateId` it was never given: a reply naming ids it never saw is untrustworthy in full, not per entry, and must not be salvaged by dropping the bad rows;
- the reply names an `elementId` that does not exist in the model, or maps one decision twice.

Accepted mappings carry provenance in each fanned-out association's `data` (`{ agent, candidateId, reason? }`). The association's own fields fill the standard envelope: `source`, `target`, `relationship`, `status`. Every validator therefore works against the contract without knowing an agent was involved. The prefilled context (catalog + decisions) is deterministic, so `cached()` composes unchanged. Like `agentScan`, the `id` option suffixes the provider id (`agent-resolve:<id>`) so multiple instances with different instructions coexist.

## Drafting descriptions: `draftDescriber` and `fitc4 draft --describe`

`draftDescriber({ exec, repositoryRoot })` builds the `describe` callback `draft()` accepts: per drafted element that claims sources and owns at least one observed file, one one-shot schema-bound call proposing a one-or-two-sentence description from a context pack of the element's owned files (fragment elements are described from their containing file, with the locator in the prompt). The CLI wires it up as `fitc4 draft --describe`, using the module config's `agent` exec.

The guardrail: the agent proposes descriptions only at draft time; the gate only critiques descriptions, never rewrites them. The pass can touch nothing but description text, and the context is deterministic, so `cached()` re-describes only the elements whose files changed. To count the TODOs left after a draft, the opt-in `missingDescriptions()` validate rule in the core package makes each one an info finding.

Abstention and failure are separate outcomes, permanently. A schema-conforming reply whose description is empty keeps that element's TODO placeholder, narrated, and the draft succeeds: a placeholder is an honest state. Any transport failure (missing CLI, not logged in, non-zero exit, timeout, off-schema reply) throws instead, so `draftDescriber` aborts the draft on the first one and nothing is written. Collapsing the two hid the most common first-run problem there is: a logged-out CLI used to report `kept the TODO` per element and `described 0 of 11 eligible elements`, exit 0, which reads as eleven models declining rather than one CLI that never ran. Aborting on the first failure rather than the eleventh follows `agentSemanticReview`'s reasoning about a dead CLI: further calls are further pointless waits, and they are not cheap ones. A logged-out `codex exec` spends about ten seconds retrying its connection before it gives up, so a per-element retry over an eleven-element draft would be nearly two minutes of waiting to be told eleven times what the first failure already said. `fitc4 draft` also skips the pass entirely when it would refuse to write, because descriptions printed to scrollback and discarded are descriptions nobody should be billed for.

The prompt is deliberately steered toward durable responsibility and away from configuration detail: ports, hostnames, environment variables, and image tags all change without the responsibility changing, and a description built from them becomes a `description-drift` finding the day a port moves. It also tells the model not to restate the element's own name, which is what a thin context otherwise produces.

## Cost and nondeterminism

Judgment about how load-bearing to make this belongs to the user, and the dials are the usual ones:

- **Model choice is a severity decision.** A haiku-class model is fine for the advisory tier, whose measured failure mode is noise a human dismisses. For an `agentScan` or `agentResolve` that gates a merge, use a model that measured perfect across the suite: `codexCli({ model: 'gpt-5.6-luna' })` and `claudeCli({ model: 'sonnet' })` both did, 35/35 on 2026-08-21. In the same run haiku's scan missed a planted one-line violation in a large compose file, and a scan miss is fail-open, invisible to the gate by construction. See the measured results in [`evals/RESULTS.md`](../evals/RESULTS.md).
- **One call waits 120 seconds, a scan waits 10 minutes.** 120 seconds is both adapters' default `timeoutMs`, and it fits the small extraction calls the resolve and validate providers make. `agentScan` budgets its own call at 10 minutes instead, because a scan is the big call of a run: an agentic exploration of a real repository takes minutes, and so can a one-shot answering over a full context pack. Override either per instance, `agentScan({ timeoutMs })` for the scan, `claudeCli({ timeoutMs })` or `codexCli({ timeoutMs })` for the rest. A timed-out call reports the wait it gave up after, names the option that raises it, and shows the tail of whatever the CLI said before the kill; a fail-closed provider turns it into a `provider-failure` error. While the scan call runs, the provider narrates a still-waiting line every 30 seconds with the elapsed time and the budget, so a long exploration stays distinguishable from a hang.
- **An unavailable CLI reports its own cause.** A failed call carries the informative end of the CLI's output rather than its opening banner, and where the output has a known machine-readable shape the adapter extracts the message instead of trimming bytes. A logged-out `claude` reports `Not logged in · Please run /login`, a logged-out `codex` its `401 Unauthorized: Missing bearer or basic authentication in header`. When the failure looks like an auth failure the message also names the command that fixes it, `claude login` or `codex login`, because neither CLI's own text offers non-interactive advice.
- **Advisory-first prototyping.** New domains start cheap: the pipeline reports private observation kinds as `info` findings (`unknown-observation-kind`), so a first draft of the instructions costs a visible nudge, not a broken build. Wire the domain into the model (ownership metadata, declared relationships, or a custom validate rule that reads your kinds) once the observations look right.
- **Trigger-driven calls.** `agentResolve` makes zero agent calls when there are no leftover candidates, matching the standing contract of the validate providers: a clean steady state costs nothing.
- **`cached()` is the cost model.** Both providers' contexts are deterministic, so steady-state CI runs replay the recorded reply for free. A live call happens only when the instructions, the prefilled context, or the exec's fingerprint change. Note the boundary honestly: with `agentic: true` the model may read file *contents* the listing does not carry, so an edit that changes no listed path can replay a stale reply until the cache is cleared. For prototyping that is acceptable. `focus` closes that hole by putting the contents in the request (and therefore in the key), and is the intermediate step before a domain graduates.
- **Decisions bound the resolve bill.** `agentResolve`'s call size scales with distinct (element, package) questions, not with import sites. Adding the hundredth import of an already-offered package changes nothing the model sees, so the cached reply replays.
- **Graduate proven domains.** A domain stabilizes when you know exactly which files matter and what shape the facts take. At that point, replace the `agentScan` instance with a small deterministic provider (a compose parser is an afternoon). Same envelope, same kinds, same resolve and validate phases; the report's provider line shows the swap. Prose is for exploring a domain, not for running one forever.

## Evals

[`evals/`](../evals/) at the repository root is the opt-in harness that measures these providers against fixtures with planted ground truth. `npm run eval` scores the recorded ideal-agent replies for free (and is the harness's own regression test), while `npm run eval -- --exec claude` measures a live model on your own CLI and billing. It never runs in CI or in any package's test suite. The fixtures double as checked-in end-to-end examples, and the `non-ts` fixture is the worked non-TypeScript `agentScan` example: a docker-compose domain, scanned in focused one-shot mode, judged by the stock deterministic rules. See [`evals/README.md`](../evals/README.md).

## Design note: a code-graph provider fits the same seams

A future code-graph-RAG-style provider, one that answers from a prebuilt symbol or call graph rather than raw file reads, needs nothing new from the plugin API:

- **Same `AgentExec` + `agentic` exploration.** The exec contract already distinguishes "answer from the prefilled context" from "explore read-only"; a graph provider is just one that prefills better. Where `agentScan` prefills a file listing, a graph provider prefills the relevant graph slice. That slice is deterministic context extracted from an index, exactly like the listing is extracted from the filesystem.
- **Same Observation envelope.** Graph-derived facts are `dependency` observations with `symbol` refs (the ref kind is already reserved in the vocabulary) and file/line evidence. Nothing downstream changes: resolve maps them onto the model, validate judges them, and the rules report unknown kinds.
- **Same attestation contract.** `examined` generalizes: the graph provider attests to the index slices it consulted (files, or index shards named as paths), and an empty attestation fails the same way. A graph nobody consulted must not read as a clean graph.
- **Same cache seam.** The graph index version belongs in the exec `fingerprint` or the prefilled context, so `cached()` keys on it and a rebuilt index invalidates replies recorded against the old one.

The only genuinely new work is the index itself and the deterministic extraction step that turns it into context. Everything else carries over unchanged: `NamedProvider<ScanProvider>` and `NamedProvider<ResolveProvider>`, the fail-closed contract, natural-key ids, `scan-root` attestations, and the association envelope `agentResolve` already fills. `agentResolve` is itself the proof for the resolve seam. A provider that maps graph-derived facts onto model elements needs nothing the plugin API does not already have.
