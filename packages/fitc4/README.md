# FitC4

Fit the code to the model: check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model is a user-defined contract — which components exist and which may depend on which. `fitc4` is the enforcement half of LikeC4: it scans your code, maps every file and import onto that model, and fails the build where the two disagree. TypeScript imports are the built-in evidence, not the limit of the contract — providers extend the same gate to anything observable about the implementation. Brownfield code adopts through [the drift ratchet](#the-drift-ratchet): declare the dependencies that really exist, tagged as drift, and burn them down — the model shows the debt, the report counts it. And agents are held to the same contract through the same CLI — see [For AI agents](#for-ai-agents).

## Setup

```sh
npm install --save-dev fitc4
npx fitc4 init
```

`init` scaffolds `fitc4.config.json` and a starter `arch/model.c4` whose single element owns `src/**`, so the very first check is green — split the placeholder into real components from there. It never overwrites existing files. Requires Node >= 22.22.3 (the CLI loads `.ts` configs with Node's native type stripping) and a `tsconfig.json`, whose module resolution the scanner uses.

The pieces, whether scaffolded or written by hand:

**A LikeC4 model** — `sources` says which files an element owns; `->` declares a permitted dependency.

```
specification {
  element system
  element container
  element component
}

model {
  acme = system 'Acme' {
    app = container 'App' {
      core = component 'Core' {
        metadata {
          sources 'src/core/**'
        }
      }

      interface = component 'Interface' {
        metadata {
          sources 'src/interface/**'
        }
      }
    }
  }

  acme.app.interface -> acme.app.core 'uses'
}
```

**`fitc4.config.json`** at your project root. Paths resolve relative to this file.

```json
{
  "$schema": "./node_modules/fitc4/schema/fitc4.config.schema.json",
  "version": 1,
  "repositoryRoot": ".",
  "model": "arch",
  "scanRoots": ["src"],
  "tsconfig": "tsconfig.json"
}
```

**Run it.**

```sh
npx fitc4
```

Most projects wire it as a script — `"fitc4": "fitc4"` — and run `npm run fitc4` in CI.

A clean run prints a summary and exits 0. A file in `src/core` importing from `src/interface` — a dependency the model does not declare — exits 1:

```text
error (1)
  relationship-direction  acme.app.core depends on acme.app.interface, but the
  model declares only acme.app.interface → acme.app.core. Declare the
  dependency that the code actually has.
    src/core/bad.ts:1  ../interface/index.ts
```

`--json` emits the full result instead of the report. `--config <path>` overrides discovery, which otherwise checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, then `fitc4.config.json` — in the working directory, then under `.fitc4/`, repeating up each ancestor. Two configs in one directory is an error rather than a silent choice.

The module forms default-export the same fields (wrap them in `defineConfig` for editor types) plus optional provider arrays — which is how the agent providers below are composed in. They load as ES modules: in a CommonJS package (no `"type": "module"`), name the config `fitc4.config.mts`. If your tsconfig typechecks the config file, keep `skipLibCheck: true` — LikeC4's own declarations do not pass a strict lib check.

## Rules

| Rule | Severity | Meaning |
|---|---|---|
| `unmapped-source` | warning | A source file is owned by no model element |
| `ambiguous-source` | error | Two elements claim the same source file |
| `missing-relationship` | error | Code crosses a boundary the model does not declare |
| `relationship-direction` | error | The model declares only the opposite direction |
| `unresolved-import` | warning | An import resolves to nothing — a broken path, a dead tsconfig alias, an undeclared package — so it cannot be checked |
| `drift-relationship` | info | Code still exercises a drift-tagged relationship; burn it down, then delete the relationship |
| `unused-drift` | warning | A drift-tagged relationship no code exercises anymore — delete it from the model |
| `unobserved-elements` | info | Leaf elements with neither `sources` nor `packages`; nothing checks them |
| `invalid-sources` | error | Ownership metadata the prefix matcher cannot honour |
| `unmatched-sources` | error | Ownership metadata that matches no scanned file |
| `invalid-packages` | error | A `packages` claim that is not an exact npm package name |
| `ambiguous-package` | error | Two elements claim the same package |
| `unmatched-packages` | error | A claimed package that no scanned file imports |
| `duplicate-relationship` | info | Two relationships share one stable identity |
| `unknown-observation-kind` | info | A provider emitted facts no rule interprets |
| `orphaned-association` | error | A provider referenced an observation that does not exist |
| `provider-failure` | error | A provider threw; other providers still ran |

An element with no `sources` is legal — a grouping element, or a component implemented elsewhere. An unowned *file* is a finding; an unowned *element* is not. Legal, but not invisible: one `unobserved-elements` info finding per run lists the leaf elements with neither `sources` nor `packages`, so deliberate abstraction stays visible rather than accidental. A relationship declared between two parents covers traffic between their descendants. Test files are excluded from the scan, by filename and by directory.

Above five `unmapped-source` findings the report renders one grouped block — the total, a by-directory breakdown, the first ten paths — because a brownfield repository's unowned files are one adoption fact, not hundreds. `--json` is unchanged and keeps every finding.

The severities above are defaults, not policy. In a `.ts` config:

```ts
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

promotes new unowned code from a nudge to a gate failure — worth doing once adoption is finished, since dependencies from unowned files are never boundary-checked. It also turns a typo'd `sources` metadata key loud: LikeC4 metadata is freeform, so `source` is silently valid and just leaves the element owning nothing.

## The drift ratchet

A brownfield codebase fails a truthful model on day one. The escape hatch is not a baseline file — it is the model: declare the dependencies that really exist and tag them as drift.

```
specification {
  tag drift

  element system
  element container
  element component
}

model {
  // ... elements as above ...

  acme.app.interface -> acme.app.core 'uses'

  acme.app.core -> acme.app.interface 'legacy reach-around' {
    #drift
  }
}
```

A drift-tagged relationship is a declared relationship, so the code it covers is permitted — but counted. Each exercised drift edge is one `drift-relationship` info finding, and the report carries a burn-down line:

```text
info (1)
  drift-relationship  acme.app.core → acme.app.interface is declared drift;
  1 dependency still rides it. Remove the code path, then delete the tagged
  relationship from the model.

drift: 1 declared · 1 exercised · 0 unused
```

When the last code path dies, the edge flips to an `unused-drift` warning whose only fix is deleting the relationship. That deletion is the ratchet: tolerated debt can shrink, never quietly persist — and it lives in model text, visible in the diagram and reviewed in diffs, not in a generated baseline file. The tag is `drift` by default (`architectureRules({ driftTag })` changes it) and must be declared in the specification — LikeC4 rejects unknown tags. `severity: { 'drift-relationship': 'error' }` forbids tolerated drift entirely; `{ 'unused-drift': 'error' }` makes the ratchet hard.

## Package claims

`sources` covers code the repository owns; `packages` metadata claims the external packages an element stands for:

```
infra = component 'Infrastructure' {
  metadata {
    sources 'src/infra/**'
    packages 'pg'
  }
}
```

A claim is an exact npm package name — `pg`, `@aws-sdk/client-s3`; string or array like `sources`; imports of any subpath map onto the claim. An import of a claimed package resolves onto the claiming element, and the standard relationship rules then judge the edge exactly like a file-to-file crossing — "only infra may import `pg`" is nothing more than the absence of a declared relationship from anywhere else. Unclaimed packages stay unrestricted, and the claims are fail-closed like `sources`: `invalid-packages`, `ambiguous-package`, and `unmatched-packages` are errors, never silent no-ops.

## As a library

Everything the CLI does is reachable from the package entry point, so you can assert on architecture inside your own test suite instead of shelling out.

```ts
import { findConfig, resolveConfig, pipelineConfig, runPipeline, exitCodeFor } from 'fitc4'

const result = await runPipeline(pipelineConfig(await resolveConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

`resolveConfig` loads all three config forms; `loadConfig` is the synchronous, JSON-only variant.

Providers are plain functions — `ScanProvider`, `ResolveProvider`, `ValidateProvider` — composed into phase arrays. `pipelineConfig` is the batteries-included default; to swap a scanner, build your own `PipelineConfig` and pass it to `runPipeline`.

## Agent providers

`fitc4/agent` adds providers that shell out to your locally installed agent CLIs (`claude`, `codex`) — your login, your billing, no API keys in fitc4. `agentOwnershipAdvisor` suggests an owner for every file the model leaves unowned; `agentSemanticReview` judges whether an element's implementation still matches its declared description. Agent findings are additive, and each provider takes a `severity`: advisory by default, part of the gate when you choose `'error'` — at which point a missing or logged-out CLI fails the build instead of being a `warning` nudge. `cached()` makes reruns with unchanged inputs free and identical.

A complete `fitc4.config.ts`:

```ts
import { defineConfig, defaultValidate } from 'fitc4'
import { agentOwnershipAdvisor, agentSemanticReview, cached, claudeCli } from 'fitc4/agent'

const agent = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // A phase that is present replaces the defaults; spreading them back in
  // keeps the deterministic rules and adds the agent providers on top.
  validate: [...defaultValidate, agentOwnershipAdvisor({ exec: agent }), agentSemanticReview({ exec: agent })],
})
```

The advisor makes zero calls on a clean repository; the review makes one call per described element (cached after the first run).

The same entry point also ships `agentScan` and `agentResolve` — a scan provider driven by prose instructions (enforce model domains no parser covers: compose files, runbooks, OpenAPI) and a resolve provider that maps external and unresolvable dependencies onto model elements, including description-only ones like an external system. Unlike the advisory validate providers these are load-bearing, so they fail closed: any exec failure, off-schema reply, or hallucinated path is a `provider-failure` error, never a quietly thinner run. They are the prototyping path for new model domains — prose explores, and a proven domain graduates to a small deterministic provider. Details: [`docs/agent-providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/agent-providers.md).

## For AI agents

FitC4's agent interface is the CLI itself: run it, read the report, fix what it names. Failing reports link back to the rules table above, and `--json` emits the full pipeline result — the `PipelineResult` type shipped in `dist/index.d.ts` — for structured consumption. FitC4 is the *enforcement* half of the ecosystem's AI story: for querying a LikeC4 model, LikeC4 ships an MCP server (`npx likec4 mcp`), and for writing the DSL there is the LikeC4 agent skill (`npx skills add https://likec4.dev/`).

The one norm an agent cannot infer from the CLI: **the model is the contract, and the cheapest path to a green build — editing the model to permit whatever the code does — defeats the tool.** If agents work in your repository, add this to your `AGENTS.md` or `CLAUDE.md`:

```markdown
## Architecture gate (fitc4)

- Run `npm run fitc4` before handing off changes; it checks the code against
  the LikeC4 architecture model. Exit 1 is an architecture violation, not a
  flaky tool.
- A finding means the code and the contract disagree. Fixing the code is the
  default. Editing the model is a design decision — legitimate when the
  architecture genuinely changed, never merely to silence a finding — and any
  model change must be called out explicitly when handing off.
- Never delete `sources` metadata or a declared relationship to make a finding
  go away: that removes code from architecture control entirely.
- Rule reference: `node_modules/fitc4/README.md#rules`. Structured output:
  `npx fitc4 --json`.
```

## Links

Source, issues, a full worked example, and the provider contract live in the [GitHub repository](https://github.com/arocnies/fitc4) — see [`example/`](https://github.com/arocnies/fitc4/tree/main/example) and [`docs/providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/providers.md). Checking JavaScript or mixed JS/TS projects? The companion package [`fitc4-dependency-cruiser`](https://www.npmjs.com/package/fitc4-dependency-cruiser) wraps dependency-cruiser as a scan provider — install both and compose it in config.
