# FitC4

Check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model says which components exist and which may depend on which. `fitc4` scans your TypeScript code, maps every file and import onto that model, and fails the build where the two disagree.

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

The module forms default-export the same fields (wrap them in `defineConfig` for editor types) plus optional provider arrays — which is how the AI providers below are composed in. They load as ES modules: in a CommonJS package (no `"type": "module"`), name the config `fitc4.config.mts`. If your tsconfig typechecks the config file, keep `skipLibCheck: true` — LikeC4's own declarations do not pass a strict lib check.

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

An element with no `sources` is legal — a grouping element, or a component implemented elsewhere. An unowned *file* is a finding; an unowned *element* is not. A relationship declared between two parents covers traffic between their descendants. Test files are excluded from the scan, by filename and by directory.

The severities above are defaults, not policy. In a `.ts` config:

```ts
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

promotes new unowned code from a nudge to a gate failure — worth doing once adoption is finished, since dependencies from unowned files are never boundary-checked. It also turns a typo'd `sources` metadata key loud: LikeC4 metadata is freeform, so `source` is silently valid and just leaves the element owning nothing.

## As a library

Everything the CLI does is reachable from the package entry point, so you can assert on architecture inside your own test suite instead of shelling out.

```ts
import { findConfig, resolveConfig, pipelineConfig, runPipeline, exitCodeFor } from 'fitc4'

const result = await runPipeline(pipelineConfig(await resolveConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

`resolveConfig` loads all three config forms; `loadConfig` is the synchronous, JSON-only variant.

Providers are plain functions — `ScanProvider`, `ResolveProvider`, `ValidateProvider` — composed into phase arrays. `pipelineConfig` is the batteries-included default; to swap a scanner, build your own `PipelineConfig` and pass it to `runPipeline`.

## AI-assisted providers

`fitc4/ai` adds providers that shell out to your locally installed agent CLIs (`claude`, `codex`) — your login, your billing, no API keys in fitc4. `aiOwnershipAdvisor` suggests an owner for every file the model leaves unowned; `aiSemanticReview` judges whether an element's implementation still matches its declared description. AI findings are additive, and each provider takes a `severity`: advisory by default, part of the gate when you choose `'error'` — at which point a missing or logged-out CLI fails the build instead of being a `warning` nudge. `cached()` makes reruns with unchanged inputs free and identical.

A complete `fitc4.config.ts`:

```ts
import { defineConfig, defaultValidate } from 'fitc4'
import { aiOwnershipAdvisor, aiSemanticReview, cached, claudeCli } from 'fitc4/ai'

const ai = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // A phase that is present replaces the defaults; spreading them back in
  // keeps the deterministic rules and adds the AI on top.
  validate: [...defaultValidate, aiOwnershipAdvisor({ exec: ai }), aiSemanticReview({ exec: ai })],
})
```

The advisor makes zero calls on a clean repository; the review makes one call per described element (cached after the first run).

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

Source, issues, a full worked example, and the provider contract live in the [GitHub repository](https://github.com/arocnies/fitc4) — see [`example/`](https://github.com/arocnies/fitc4/tree/main/example) and [`docs/providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/providers.md).
