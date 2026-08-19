# FitC4

Fit the code to the model: check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model is a user-defined contract — which components exist and which may depend on which. FitC4 is the enforcement half of that: LikeC4 describes and renders the architecture, `fitc4` scans the code, maps every file and import onto the model, and fails the build where the two disagree. The model is the source of truth; the code is the thing being fitted to it. TypeScript imports are what it checks out of the box; providers extend the same gate to anything observable about the implementation — compose files, runbooks, OpenAPI.

Two situations the design leans into:

- **Brownfield code.** Declare the dependencies that really exist and tag them as drift: the model shows the debt as edges in the diagram, the report counts it down, and the ratchet only turns one way. See [the drift ratchet](#the-drift-ratchet).
- **Agent-written code.** Agents are held to the same contract through the same CLI; they can extend the gate with providers; and the agent providers let them prototype new model domains that deterministic providers later graduate.

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

**`example/fitc4.config.json`** — where things are. Paths resolve relative to this file.

```json
{
  "$schema": "../packages/fitc4/schema/fitc4.config.schema.json",
  "version": 1,
  "repositoryRoot": ".",
  "model": "arch",
  "scanRoots": ["src"],
  "tsconfig": "tsconfig.json"
}
```

The `$schema` points into this workspace because the example lives beside the package. Installed from npm it is `./node_modules/fitc4/schema/fitc4.config.schema.json` — the schema ships with the package rather than being copied into your repository.

**Run it.**

```bash
npx fitc4
```

```text
scan typescript-imports · resolve source-root · validate architecture-rules
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

scan typescript-imports · resolve source-root · validate architecture-rules
6 observations · 5 associations · 1 errors, 0 warnings, 0 info
```

Exit code 1. `--json` emits the full result instead of the report; `--config <path>` overrides discovery.

The example also carries [`fitc4.agent.config.ts`](example/fitc4.agent.config.ts) — the same gate plus the `fitc4/agent` advisory providers, run on demand with `npm run fitc4:agent -w example`. A non-discovery filename plus `--config` is the pattern for keeping an agent-assisted variant beside the deterministic one CI runs: an unowned file gets the standard `unmapped-source` warning *and* an agent `ownership-suggestion` naming the element that should own it (or saying the model is missing one), and described elements get their implementations reviewed against their descriptions. Requires a logged-in `claude` CLI; without one the run still passes and reports `agent-unavailable`.

Agents get the same treatment as humans: the CLI is the interface, failing reports link the rule reference, and `--json` emits the typed `PipelineResult`. What an agent cannot infer is the norm that the model is the contract — so the [npm README](packages/fitc4/README.md#for-ai-agents) ships a copy-paste `AGENTS.md` block for repositories where agents work, and [`example/AGENTS.md`](example/AGENTS.md) is the checked-in version. For querying and authoring the model itself, LikeC4 ships an MCP server (`npx likec4 mcp`) and an agent skill — FitC4 is the enforcement half, and ships the matching enforcement-side Claude Code skill at [`packages/fitc4/skills/fitc4/`](packages/fitc4/skills/fitc4) (`node_modules/fitc4/skills/fitc4/` when installed).

## Where things live

`fitc4.config.json` goes at your project root, beside `tsconfig.json` — `npx fitc4 init` scaffolds it along with a starter model. Discovery starts at the working directory and checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, then `fitc4.config.json` — directly, then under `.fitc4/` — repeating up each ancestor, so the command works from the project root or anywhere inside it. The root-level file wins over `.fitc4/`, and two config files in one directory is an error rather than a silent choice.

A module-form config unlocks custom providers: it default-exports the same fields plus optional `scan`, `resolve`, and `validate` provider arrays. A phase that is present replaces the defaults for that phase; absent means the default — merge semantics are yours, in your config file, where you can see them. Module configs load as ES modules, so a CommonJS package names its config `fitc4.config.mts`. See [`docs/providers.md`](docs/providers.md) for the provider contract and a worked example.

The model itself lives wherever `model` points. It is authored architecture documentation with value independent of this tool — readable, reviewable in a pull request, renderable into diagrams by LikeC4 — so it does not belong in a hidden tool directory. The example keeps it in `arch/`; the name is yours.

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

Everything from `invalid-sources` down exists so the gate cannot fail open. A typo in `sources` used to make every prefix stop matching, which turned architecture errors into a clean exit 0.

The severities are defaults, not policy: in a `.ts` config, `validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]` makes new unowned code fail the gate — worth doing once adoption is finished, since dependencies from unowned files are never boundary-checked. Every rule id in the table accepts an override.

Above five `unmapped-source` findings the report renders one grouped block — the total, a by-directory breakdown, the first ten paths — because a brownfield repository's 450 unowned files are one adoption fact, not 450 separate ones. `--json` is unchanged and keeps every finding.

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

  example.app.interface -> example.app.core 'uses'

  example.app.core -> example.app.interface 'legacy reach-around' {
    #drift
  }
}
```

A drift-tagged relationship is a declared relationship, so the code it covers is permitted — but counted. Each exercised drift edge is one `drift-relationship` info finding, and the report carries a burn-down line:

```text
info (1)
  drift-relationship  example.app.core → example.app.interface is declared drift;
  1 dependency still rides it. Remove the code path, then delete the tagged
  relationship from the model.
    src/core/bad.ts:1  ../interface/index.js

drift: 1 declared · 1 exercised · 0 unused
```

When the last code path dies, the edge flips to an `unused-drift` warning whose only fix is deleting the relationship. That deletion is the ratchet: the set of tolerated edges can shrink, never quietly persist. And the debt lives in model text rather than machine state — every drift edge is visible in the diagram, added and removed in reviewable diffs, and the counts are recomputed from the code on every run, so there is no baseline file to regenerate or rubber-stamp.

The tag is `drift` by default (`architectureRules({ driftTag })` changes it) and must be declared in the specification — LikeC4 rejects unknown tags. Two promotions tune the policy: `severity: { 'drift-relationship': 'error' }` forbids tolerated drift entirely; `{ 'unused-drift': 'error' }` makes the ratchet hard. [`example/README.md`](example/README.md) walks the full loop as Exercise 3.

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

A claim is an exact npm package name — `pg`, `@aws-sdk/client-s3`; string or array like `sources`; imports of any subpath map onto the claim. An import of a claimed package resolves onto the claiming element, and from there the standard relationship rules judge the edge exactly like a file-to-file crossing — "only infra may import `pg`" is nothing more than the absence of a declared relationship from anywhere else. Unclaimed packages stay unrestricted, and the claims are fail-closed like `sources`: a value that is not an exact package name (`invalid-packages`), a package claimed by two elements (`ambiguous-package`), or a claim no scanned file imports (`unmatched-packages`) is an error, never a silent no-op.

## The model

`sources` is a repository-relative directory prefix, optionally ending in `/**`. A leading `./` or `/` and Windows separators are tolerated; anything the prefix matcher cannot honour — a mid-path wildcard, a filename — is rejected rather than silently matching nothing.

One trap sits outside the gate's reach: `sources` is a metadata key, and LikeC4 metadata is freeform, so a typo like `source` is silently valid — the element just owns nothing and its files surface as `unmapped-source` warnings. Promoting that rule to `error` is what turns the typo loud.

An element with no `sources` is legal: a grouping element, or a component implemented elsewhere. **An unowned file is a finding; an unowned element is not.** Legal, but not invisible: one `unobserved-elements` info finding per run lists the leaf elements with neither `sources` nor `packages`, so a deliberately abstract element — an external system, a person — stays visibly unenforced rather than accidentally so. A relationship declared between two parents covers traffic between their descendants, and an element never "crosses a boundary" into its own parent or child — LikeC4 refuses to declare parent-child relationships, so reporting those would leave no fix available.

The scanner walks `scanRoots` on disk rather than a TypeScript `Program`'s file list, so a file nothing imports is still checked for ownership. A root that is missing, misspelled, or holds no TypeScript is an error rather than an empty pass. Test files are excluded, by filename and by directory.

## Using it as a library

Everything the CLI does is reachable from the package entry point, so a host project can assert on architecture inside its own test suite instead of shelling out.

```ts
import { findConfig, resolveConfig, pipelineConfig, runPipeline, exitCodeFor } from 'fitc4'

const result = await runPipeline(pipelineConfig(await resolveConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

`resolveConfig` loads all three config forms — a `.ts` or `.js` config would make the JSON-only `loadConfig` throw.

Providers are plain functions — `ScanProvider`, `ResolveProvider`, `ValidateProvider` — composed into phase arrays. `pipelineConfig` is the batteries-included default; a caller wanting a different scanner builds its own `PipelineConfig` and passes it to `runPipeline`. There is no registry, lifecycle, or discovery system.

The `fitc4/agent` entry point adds agent providers over locally installed agent CLIs (`claude`, `codex`) — cached on their inputs, and never imported by the core. They come in two tiers. The validate providers (ownership advice, semantic review) are advisory: additive findings, `severity` per provider, part of the gate only when you choose `'error'`. The scan and resolve providers (`agentScan`, `agentResolve`) are load-bearing and therefore fail closed — `agentScan` observes model domains no parser covers from prose instructions, `agentResolve` maps external and unresolvable dependencies onto elements the code cannot reach, including description-only ones, and any failure or off-schema reply is a `provider-failure` error rather than a quietly thinner run. They are also the prototyping path: prose explores a new domain, and a domain that proves out graduates to a small deterministic provider — same envelope, same rules. See [`docs/agent-providers.md`](docs/agent-providers.md). The agent providers are measured, not just tested: [`evals/`](evals) runs four fixture projects with planted ground truth — greenfield, brownfield with tolerated drift, a docker-compose model domain no TypeScript parser sees (the worked non-TS `agentScan` example), and an exploratory markdown-runbook domain where the agent walks the repository itself — scored against expected findings, in a free stub mode by default or against a real agent CLI with `npm run eval -- --exec claude`.

Extending a phase spreads the defaults back in — `validate: [...defaultValidate, myProvider]` — and every report names the providers that composed each phase. See [`docs/providers.md`](docs/providers.md) for the provider contract.

## The provider vocabulary

The one contract that crosses provider boundaries is the `kind` on an `Observation` or a `Ref`. A scanner emitting `import` where the rules read `dependency` produces no findings and a clean exit — indistinguishable from a healthy repository. So the standard set is named in [`kinds.ts`](packages/fitc4/src/kinds.ts) rather than left as string literals in two files.

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
packages/fitc4/                     the library and CLI
packages/fitc4-dependency-cruiser/  companion package: dependency-cruiser as a scan provider
example/                            a project it checks
evals/                              agent-provider evals: four fixtures with planted ground truth
docs/                               the design of record and provider references
```

`fitc4-dependency-cruiser` wraps dependency-cruiser's `cruise()` as a scan provider for JavaScript and mixed JS/TS projects. It is a separate npm package with its own [README](packages/fitc4-dependency-cruiser/README.md) so the `fitc4` core keeps zero runtime dependencies beyond TypeScript and LikeC4; consumers install both and compose it in config. It is also the template for further companion packages: the provider contract is the whole integration surface.

```bash
npm install
npm run verify              # everything below
npm run check -w fitc4     # typecheck, build, tests
npm run check -w example    # model validation, typecheck, tests, fitc4
npm run view -w example     # live LikeC4 viewer
npm run smoke               # pack the tarball, install it into a fresh consumer, run it
```

`example` depends on `fitc4` as a workspace package and invokes it through `node_modules/.bin`, so the checked-in example exercises the same path a consumer would rather than a shortcut. That still is not the whole path: workspace symlinks ignore the `files` allowlist and parts of the `exports` map, so a packaging mistake is invisible to every workspace test. `npm run smoke` closes that gap — it packs the real tarball, installs it into a throwaway project, and asserts the CLI, the library entry point, the shipped schema, and both gate directions. Run it before publishing.

`fitc4` tests its own pipeline against fixture repositories in `packages/fitc4/test/fixtures/`, each a miniature project with its own `model.c4` and `tsconfig.json`. It assumes nothing about how a host project tests itself.

FitC4 is also self-hosting: [`packages/fitc4/arch/model.c4`](packages/fitc4/arch/model.c4) models its own source, and `check` runs the built CLI against it. CI runs `verify` and `smoke` on Linux, node 22 and 26. Windows is untested — paths are POSIX-normalized throughout, but no Windows leg runs until there's a Windows consumer to justify it.

## Toolchain notes

`fitc4` depends on TypeScript 6 at runtime, because 7.0.2 does not expose the classic compiler API the import scanner needs; the example typechecks with TypeScript 7. TypeScript 6 also no longer auto-includes `@types/*`, so [`packages/fitc4/tsconfig.json`](packages/fitc4/tsconfig.json) lists them explicitly.

`npm run build -w fitc4` cleans and re-emits `dist/` — JavaScript and declarations, no source maps since `src/` does not ship — from [`tsconfig.build.json`](packages/fitc4/tsconfig.build.json). Node strips types natively, so `node src/cli.ts` runs here, but a published package cannot assume its consumers are on Node 26. The sources import each other with `.ts` extensions, which `rewriteRelativeImportExtensions` converts on emit. `build` runs as part of `check` so the emit path cannot rot unnoticed, and as `prepare` so a fresh `npm install` produces `dist/` — npm links a `bin` only when its target exists, so without it a clean clone leaves `example` unable to find the `fitc4` command.

[`docs/DESIGN.md`](docs/DESIGN.md) is the design of record.
