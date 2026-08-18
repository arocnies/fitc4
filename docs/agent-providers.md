# Agent scan and resolve providers

Two providers from `fitc4/agent` extend the gate into territory the deterministic providers cannot reach, under the same fail-closed discipline: `agentScan` observes model domains no parser covers, and `agentResolve` maps leftover observations onto model elements no `sources` prefix can claim. Both are prototyping tools first — see [Cost and nondeterminism](#cost-and-nondeterminism). The provider contract they implement, the shared exec layer, and the *advisory* validate providers (`agentOwnershipAdvisor`, `agentSemanticReview`) are covered in [`providers.md`](providers.md).

## The `agent-scan` provider

`agentScan` is a scan provider driven by prose instead of a parser. The TypeScript scanner sees imports; it cannot see that `docker-compose.yml` wires one service to another, that a runbook names a component, or that an OpenAPI file declares a dependency between systems. `agentScan` lets a user enforce those model domains anyway: describe in prose what to observe, and the agent explores the repository read-only and reports standard `Observation`s that feed the same deterministic resolve and validate phases as any other scanner's.

This is the prototyping story for new model domains: an agent (human or otherwise) writes instructions, the deterministic rules judge whatever comes back, and a domain that proves its worth graduates to a purpose-built deterministic provider.

### How it works

- **Deterministic prefilled context.** The provider enumerates the files under `roots` (default: the repository root; bounded by `maxFiles`, default 300) and prefills the request with that listing plus the user's instructions. If the listing is truncated, the context says so — the model must know its map is partial. Because the context is a pure function of the repository and the options, the request composes with `cached()` unchanged: a rerun with unchanged inputs replays the recorded reply, free and identical.
- **Read-only exploration.** The request sets `agentic: true`, so the exec layer permits read-only repository access (`claude` gets `Read,Grep,Glob`; `codex` runs in a read-only sandbox). The reply must still come back as a single JSON value matching the reply schema.
- **Standard observations out.** Replies carry observations (`kind`, `subject`, optional `target`, optional `evidence`) plus a required `examined: string[]` — the files the model actually read. Each examined path becomes a standard `scan-root` observation: the coverage attestation the rules use to know what the code sample was. Observation kinds outside the standard set are legal; the `unknown-observation-kind` rule reports them at `info` rather than dropping them.

### The fail-closed contract

`agentScan` is deliberately stricter than the agent validate providers. Those are advisory enrichment — every deterministic finding still stands when they degrade to an `agent-unavailable` warning. A scanner is load-bearing: its observations *are* the coverage the rules judge, so an absent scanner must never look like a clean scan. Concretely, each of these **throws**, and the pipeline reports one `provider-failure` error finding attributed to the provider:

- the exec fails (missing CLI, logged out, timeout, non-zero exit);
- the reply is off-schema — parsing is not conforming;
- `examined` is empty — a scan that read nothing observed nothing, and zero observations must not read as a clean domain;
- any path in `subject`/`target`/`evidence`/`examined` is absolute, escapes the repository root, or does not exist on disk. A hallucinated path is a claim about code that is not there; it fails the run visibly rather than being silently dropped, because dropping it would let the rest of the reply pass as trustworthy.

A failed provider contributes nothing — no half-scan — and the other providers still run.

### A worked config

```ts
import { defineConfig, defaultValidate, typescriptImports, TYPESCRIPT_IMPORTS_PROVIDER_ID } from 'fitc4'
import { agentScan, cached, claudeCli } from 'fitc4/agent'

const exec = cached(claudeCli({ model: 'sonnet' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // Present replaces: spread the deterministic scanner back in explicitly.
  scan: [
    {
      id: TYPESCRIPT_IMPORTS_PROVIDER_ID,
      run: typescriptImports({ tsconfigPath: 'tsconfig.json', roots: ['src'] }),
    },
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
  validate: [...defaultValidate],
})
```

Two instances coexist because `id` suffixes the provider id (`agent-scan:compose`, `agent-scan:docs`): the pipeline namespaces every observation id with the provider id it was composed under, so distinct suffixes are what keep two instances' attestations from colliding.

## The `agent-resolve` provider

`agentResolve` is a resolve provider for the observations the deterministic resolvers cannot map: dependencies on external packages, unresolvable specifiers, implied links — anything whose target is not a file under a `sources` prefix. This is what makes description-only "pure thought" elements reachable by the gate. An external system or a managed queue has no source files to own, so no code edge ever resolves to it and nothing the code does to it is ever checked. `agentResolve` reads the element catalog (id, title, description, ownership) and the leftover observations, and proposes `resolved` associations — which the standard relationship rules then judge exactly like a deterministic edge: undeclared crossings become `missing-relationship` errors, declared ones pass.

It is used **alongside** the default resolver, never instead of it:

```ts
import { defineConfig, defaultResolve, defaultValidate } from 'fitc4'
import { agentResolve, cached, claudeCli } from 'fitc4/agent'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  resolve: [
    ...defaultResolve,
    agentResolve({
      exec: cached(claudeCli({ model: 'sonnet' })),
      instructions:
        'Requests to payments.internal and imports of the stripe SDK belong to the ' +
        'payments-gateway element. Message-broker clients belong to the queue element.',
    }),
  ],
  validate: [...defaultValidate],
})
```

### The worked example

Say the model declares a description-only `demo.external.payments` ('Third-party payments API') and the code contains `import Stripe from 'stripe'` in a file owned by `demo.app.core`. The TypeScript scanner emits a `dependency` observation with a module target; `source-root` can only mark it `unresolved` — an external package lives under no `sources` prefix. `agentResolve` sends that observation (with the element catalog) to the model, gets back `{ observationId, elementId: 'demo.external.payments' }`, and emits a `resolved` association `demo.app.core → demo.external.payments`. If the model declares that relationship, the run passes; if not, the standard rules report `missing-relationship` — an edge that previously escaped the gate entirely is now judged by it.

### Leftover-candidates scoping

Only observations `source-root` cannot map are sent, recomputed per run from the same inputs it reads (providers recompute rather than share state by design):

- `unresolved-dependency` observations, and `dependency` observations whose target is a module/external specifier — never dependencies with repository-file targets, which are `source-root`'s job, and never external dependencies whose package an element claims via `packages` metadata, which `source-root` already maps deterministically;
- only where the subject file has exactly one owning element (longest `sources` prefix, mirroring `source-root`) — without an unambiguous owner there is no source end for a judgeable association.

Candidates beyond `maxObservations` (default 100) are announced as truncated in the context and simply stay unmapped — still visible through the existing rules (`unresolved-import`, and the absence of a declared edge), not a failure. The reply may likewise map zero, some, or all candidates: an omitted candidate is a legitimate "I don't know" and keeps its deterministic `unresolved` association.

### The fail-closed contract

Same discipline as `agentScan`, same rationale stated the other way around: a resolver that silently fails produces fewer associations, which means fewer checks, which looks like a clean run — the exact fail-open the project exists to prevent. Each of these **throws**, becoming one `provider-failure` error finding:

- the exec fails or the reply is off-schema;
- the reply names an `observationId` it was never given — the core would catch it later as `orphaned-association`, but the provider does not rely on that: a reply naming ids it never saw is untrustworthy in full, not per entry, and must not be salvaged by dropping the bad rows;
- the reply names an `elementId` that does not exist in the model, or maps one observation twice.

Accepted mappings carry provenance in the association's `data` (`{ agent, reason? }`), and the association's own fields — `source`, `target`, `relationship`, `status` — fill the standard envelope, so every validator works against the contract without knowing an agent was involved. The prefilled context (catalog + candidates) is deterministic, so `cached()` composes unchanged. Like `agentScan`, the `id` option suffixes the provider id (`agent-resolve:<id>`) so multiple instances with different instructions coexist.

## Cost and nondeterminism

Judgment about how load-bearing to make this belongs to the user, and the dials are the usual ones:

- **Advisory-first prototyping.** New domains start cheap: private observation kinds surface as `info` findings (`unknown-observation-kind`), so a first draft of the instructions costs a visible nudge, not a broken build. Wire the domain into the model (ownership metadata, declared relationships, or a custom validate rule that reads your kinds) once the observations look right.
- **Trigger-driven calls.** `agentResolve` makes zero agent calls when there are no leftover candidates, matching the standing contract of the validate providers: a clean steady state costs nothing.
- **`cached()` is the cost model.** Both providers' contexts are deterministic, so steady-state CI runs replay the recorded reply for free. A live call happens only when the instructions, the listing or candidates, or the exec's fingerprint change. Note the boundary honestly: with `agentic: true` the model may read file *contents* the listing does not carry, so an edit that changes no listed path can replay a stale reply until the cache is cleared — acceptable for prototyping, and one reason proven domains should graduate.
- **Graduate proven domains.** Once a domain stabilizes — you know exactly which files matter and what shape the facts take — replace the `agentScan` instance with a small deterministic provider (a compose parser is an afternoon). Same envelope, same kinds, same resolve and validate phases; the report's provider line shows the swap. Prose is for exploring a domain, not for running one forever.

## Design note: a code-graph provider fits the same seams

A future code-graph-RAG-style provider — one that answers from a prebuilt symbol/call graph rather than raw file reads — needs nothing new from the plugin surface:

- **Same `AgentExec` + `agentic` exploration.** The exec contract already distinguishes "answer from the prefilled context" from "explore read-only"; a graph provider is just one that prefills better. Where `agentScan` prefills a file listing, a graph provider prefills the relevant graph slice — deterministic context extracted from an index, exactly like the listing is extracted from the filesystem.
- **Same Observation envelope.** Graph-derived facts are `dependency` observations with `symbol` refs (the ref kind is already reserved in the vocabulary) and file/line evidence. Nothing downstream changes: resolve maps them onto the model, validate judges them, unknown kinds are reported.
- **Same attestation contract.** `examined` generalizes cleanly: the graph provider attests to the index slices it consulted (files, or index shards named as paths), and an empty attestation fails the same way — a graph nobody consulted must not read as a clean graph.
- **Same cache seam.** The graph index version belongs in the exec `fingerprint` or the prefilled context, so `cached()` keys on it and a rebuilt index invalidates replies recorded against the old one.

The only genuinely new work is the index itself and the deterministic extraction step that turns it into context. The provider surface — `NamedProvider<ScanProvider>` / `NamedProvider<ResolveProvider>`, the fail-closed contract, natural-key ids, `scan-root` attestations, the association envelope `agentResolve` already fills — carries over unchanged. `agentResolve` is itself the proof for the resolve seam: a provider that maps graph-derived facts onto model elements needs nothing the plugin surface does not already have.
