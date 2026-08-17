# soffit

Check an implementation against a LikeC4 architecture contract.

A LikeC4 model says which components exist and which may depend on which. `soffit` scans the code, maps every file and import onto that model, and fails the build where the two disagree. The model is the source of truth; the code is the thing being checked.

## A complete example

Everything below is the checked-in [`example/`](example), which runs on every `npm run verify`.

**`example/arch/model.c4`** — the contract. `sources` says which files an element owns; `->` declares a permitted dependency.

```
specification {
  element system
  element container
  element component
}

model {
  example = system 'Example App' {
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

  example.app.interface -> example.app.core 'uses'
}
```

**`example/soffit.config.json`** — where things are. Paths resolve relative to this file.

```json
{
  "$schema": "../packages/soffit/schema/soffit.config.schema.json",
  "version": 1,
  "repositoryRoot": ".",
  "model": "arch",
  "scanRoots": ["src"],
  "tsconfig": "tsconfig.json"
}
```

The `$schema` points into this workspace because the example lives beside the package. Installed from npm it is `./node_modules/soffit/schema/soffit.config.schema.json` — the schema ships with the package rather than being copied into your repository.

**Run it.**

```bash
npx soffit
```

```text
4 observations · 3 associations · 0 errors, 0 warnings, 0 info
```

Now add `example/src/core/bad.ts` importing the other way — `Core` reaching into `Interface`:

```text
error (1)
  relationship-direction  example.app.core depends on example.app.interface, but the
  model declares only example.app.interface → example.app.core. Declare the
  dependency that the code actually has.
    architecture-rules · architecture-rules/relationship-direction/example.app.core->example.app.interface
    src/core/bad.ts:1  ../interface/index.ts

6 observations · 5 associations · 1 errors, 0 warnings, 0 info
```

Exit code 1. `--json` emits the full result instead of the report; `--config <path>` overrides discovery.

## Where things live

`soffit.config.json` goes at your project root, beside `tsconfig.json`. Discovery starts at the working directory, checks `./soffit.config.json` then `./.soffit/soffit.config.json`, and repeats up each ancestor — so the command works from the project root or from anywhere inside it. The root-level file wins, so hoisting a config out of `.soffit/` is never silently overruled by the copy left behind.

The model itself lives wherever `model` points. It is authored architecture documentation with value independent of this tool — readable, reviewable in a pull request, renderable into diagrams by LikeC4 — so it does not belong in a hidden tool directory. The example keeps it in `arch/`; the name is yours.

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

The last six exist so the gate cannot fail open. A typo in `sources` used to make every prefix stop matching, which turned architecture errors into a clean exit 0.

## The model

`sources` is a repository-relative directory prefix, optionally ending in `/**`. A leading `./` or `/` and Windows separators are tolerated; anything the prefix matcher cannot honour — a mid-path wildcard, a filename — is rejected rather than silently matching nothing.

An element with no `sources` is legal: a grouping element, or a component implemented elsewhere. **An unowned file is a finding; an unowned element is not.** A relationship declared between two parents covers traffic between their descendants, and an element never "crosses a boundary" into its own parent or child — LikeC4 refuses to declare parent-child relationships, so reporting those would leave no fix available.

The scanner walks `scanRoots` on disk rather than a TypeScript `Program`'s file list, so a file nothing imports is still checked for ownership. A root that is missing, misspelled, or holds no TypeScript is an error rather than an empty pass. Test files are excluded, by filename and by directory.

## Using it as a library

Everything the CLI does is reachable from the package entry point, so a host project can assert on architecture inside its own test suite instead of shelling out.

```ts
import { findConfig, loadConfig, pipelineConfig, runPipeline, exitCodeFor } from 'soffit'

const result = await runPipeline(pipelineConfig(loadConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

Providers are plain functions — `ScanProvider`, `ResolveProvider`, `ValidateProvider` — composed into phase arrays. `pipelineConfig` is the batteries-included default; a caller wanting a different scanner builds its own `PipelineConfig` and passes it to `runPipeline`. There is no registry, lifecycle, or discovery system.

## The provider vocabulary

The one contract that crosses provider boundaries is the `kind` on an `Observation` or a `Ref`. A scanner emitting `import` where the rules read `dependency` produces no findings and a clean exit — indistinguishable from a healthy repository. So the standard set is named in [`kinds.ts`](packages/soffit/src/kinds.ts) rather than left as string literals in two files.

| `Observation.kind` | Meaning |
|---|---|
| `file` | A source file exists and is in scope for ownership |
| `dependency` | `subject` depends on `target` |
| `unresolved-dependency` | A dependency whose target could not be resolved |
| `scan-root` | A path the provider actually looked at |

| `Ref.kind` | Points at |
|---|---|
| `element` | A LikeC4 element, whatever its C4 kind |
| `relationship` | A declared relationship, by stable derived id |
| `file` | A repository-relative source path |
| `directory` | A repository-relative directory path |
| `module` | A module specifier as written |
| `symbol` | A named declaration inside a file (reserved) |
| `observation` | An earlier observation, by id |
| `provider` | A provider, by its composed id |

Kinds stay open: a provider may emit its own, and two that understand each other's private kinds may cooperate. What the standard set buys is a default that works. A kind outside it is reported at `info`, so a vocabulary mismatch is visible rather than silent.

`element` rather than `component` on purpose — an element carrying `sources` may be a container just as easily, and copying the C4 kind out of the model is how a copy starts contradicting it.

## Developing

```text
packages/soffit/   the library and CLI
example/           a project it checks
docs/              design history
```

```bash
npm install
npm run verify              # everything below
npm run check -w soffit     # typecheck, build, tests
npm run check -w example    # model validation, typecheck, tests, soffit
npm run view -w example     # live LikeC4 viewer
npm run smoke               # pack the tarball, install it into a fresh consumer, run it
```

`example` depends on `soffit` as a workspace package and invokes it through `node_modules/.bin`, so the checked-in example exercises the same path a consumer would rather than a shortcut. That still is not the whole path: workspace symlinks ignore the `files` allowlist and parts of the `exports` map, so a packaging mistake is invisible to every workspace test. `npm run smoke` closes that gap — it packs the real tarball, installs it into a throwaway project, and asserts the CLI, the library entry point, the shipped schema, and both gate directions. Run it before publishing.

`soffit` tests its own pipeline against fixture repositories in `packages/soffit/test/fixtures/`, each a miniature project with its own `model.c4` and `tsconfig.json`. It assumes nothing about how a host project tests itself.

## Toolchain notes

`soffit` depends on TypeScript 6 at runtime, because 7.0.2 does not expose the classic compiler API the import scanner needs; the example typechecks with TypeScript 7. TypeScript 6 also no longer auto-includes `@types/*`, so [`packages/soffit/tsconfig.json`](packages/soffit/tsconfig.json) lists them explicitly.

`npm run build -w soffit` emits `dist/` — JavaScript, declarations, and source maps — from [`tsconfig.build.json`](packages/soffit/tsconfig.build.json). Node strips types natively, so `node src/cli.ts` runs here, but a published package cannot assume its consumers are on Node 26. The sources import each other with `.ts` extensions, which `rewriteRelativeImportExtensions` converts on emit. `build` runs as part of `check` so the emit path cannot rot unnoticed, and as `prepare` so a fresh `npm install` produces `dist/` — npm links a `bin` only when its target exists, so without it a clean clone leaves `example` unable to find the `soffit` command.

The package is `private: true` until the name is claimed on npm, where `soffit` is currently unregistered.

The design history is in [`docs/`](docs); [`POC-DESIGN-v4.md`](docs/POC-DESIGN-v4.md) is the design of record.
