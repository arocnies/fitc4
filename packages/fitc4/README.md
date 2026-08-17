# FitC4

Check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model says which components exist and which may depend on which. `fitc4` scans your TypeScript code, maps every file and import onto that model, and fails the build where the two disagree.

## Setup

Three pieces: a model, a config, and the command.

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

A clean run prints a summary and exits 0. A file in `src/core` importing from `src/interface` — a dependency the model does not declare — exits 1:

```text
error (1)
  relationship-direction  acme.app.core depends on acme.app.interface, but the
  model declares only acme.app.interface → acme.app.core. Declare the
  dependency that the code actually has.
    src/core/bad.ts:1  ../interface/index.ts
```

`--json` emits the full result instead of the report. `--config <path>` overrides discovery, which otherwise checks `./fitc4.config.json`, then `./.fitc4/fitc4.config.json`, then the same two in each ancestor of the working directory.

## Rules

| Rule | Severity | Meaning |
|---|---|---|
| `unmapped-source` | warning | A source file is owned by no model element |
| `ambiguous-source` | error | Two elements claim the same source file |
| `missing-relationship` | error | Code crosses a boundary the model does not declare |
| `relationship-direction` | error | The model declares only the opposite direction |
| `unresolved-import` | warning | A relative import resolves to nothing, so it cannot be checked |
| `invalid-sources` | error | Ownership metadata the prefix matcher cannot honour |
| `unmatched-sources` | error | Ownership metadata that matches no scanned file |
| `duplicate-relationship` | info | Two relationships share one stable identity |
| `unknown-observation-kind` | info | A provider emitted facts no rule interprets |
| `orphaned-association` | error | A provider referenced an observation that does not exist |
| `provider-failure` | error | A provider threw; other providers still ran |

An element with no `sources` is legal — a grouping element, or a component implemented elsewhere. An unowned *file* is a finding; an unowned *element* is not. A relationship declared between two parents covers traffic between their descendants. Test files are excluded from the scan, by filename and by directory.

## As a library

Everything the CLI does is reachable from the package entry point, so you can assert on architecture inside your own test suite instead of shelling out.

```ts
import { findConfig, loadConfig, pipelineConfig, runPipeline, exitCodeFor } from 'fitc4'

const result = await runPipeline(pipelineConfig(loadConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

Providers are plain functions — `ScanProvider`, `ResolveProvider`, `ValidateProvider` — composed into phase arrays. `pipelineConfig` is the batteries-included default; to swap a scanner, build your own `PipelineConfig` and pass it to `runPipeline`.

## AI-assisted providers

`fitc4/ai` adds providers that shell out to your locally installed agent CLIs (`claude`, `codex`) — your login, your billing, no API keys in fitc4. `aiOwnershipAdvisor` suggests an owner for every file the model leaves unowned; `aiSemanticReview` judges whether an element's implementation still matches its declared description. AI findings are additive, and each provider takes a `severity`: advisory by default, part of the gate when you choose `'error'` — at which point a missing or logged-out CLI fails the build instead of being a `warning` nudge. `cached()` makes reruns with unchanged inputs free and identical.

```ts
import { presetValidate } from 'fitc4'
import { cached, claudeCli, aiOwnershipAdvisor } from 'fitc4/ai'

// in fitc4.config.ts:
validate: [...presetValidate, aiOwnershipAdvisor({ exec: cached(claudeCli({ model: 'haiku' })) })]
```
