# FitC4

Fit the code to the model: check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model is a user-defined contract. It says which components exist and which may depend on which. `fitc4` is the enforcement half of LikeC4: it scans your code, maps every file and import onto that model, and fails the build where the two disagree.

- **A deterministic CI gate.** fitc4 checks imports against declared relationships. Same inputs, same findings, exit 1 on violation. TypeScript imports are what it checks out of the box. Providers extend the same gate to anything else observable about the implementation, such as compose files, runbooks, or OpenAPI specs.
- **A way in for brownfield code.** A truthful model fails on day one. [Tolerated drift](#tolerated-drift) declares the debt in the model, counts it in every report, and only lets it shrink.
- **A contract agents are held to.** Agents write more of the code now. fitc4 holds them to the same model through the same CLI, and ships the norms that keep "edit the model to silence the finding" off the table. See [For AI agents](#for-ai-agents).

## Quickstart

```sh
npm install --save-dev fitc4
npx fitc4 init
```

`init` scaffolds `fitc4.config.json`, a starter `arch/model.c4` whose single element owns `src/**` so the very first check is green, and an `AGENTS.md` carrying the norms below. Split the placeholder into real components from there. It never overwrites existing files. Requires Node >= 22.22.3 (the CLI loads `.ts` configs with Node's native type stripping) and a `tsconfig.json`, whose module resolution the scanner uses. `fitc4` depends on `likec4` as a caret range (`^1.59.2`), so it dedupes with the likec4 your project already installs; an advisory CI leg runs the suite against `likec4@latest` so skew with new releases surfaces there, not in your install.

The pieces, whether scaffolded or written by hand:

**A LikeC4 model.** `sources` says which files an element owns; `->` declares a permitted dependency.

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

Most projects add a `"fitc4": "fitc4"` script and run `npm run fitc4` in CI.

## Draft a model from existing code

`init` scaffolds a placeholder. `npx fitc4 draft` goes further on a brownfield repository: it runs the configured scan providers, no model needed, and writes a first-draft model from what they observed. One element per first-level directory under each scan root, one relationship per observed cross-element dependency (the dependency count rides a trailing comment), and one stub element claiming every observed external package so the resolve tier is quiet on day one. It consumes the observation contract, not TypeScript specifics, so it drafts from whatever scan providers the config composes, `fitc4-dependency-cruiser` and the agent scanners included. Drafting with agent scan providers needs the agent CLI available.

Every relationship is tagged as drift by default, so the very first gate run is green and the drift line becomes the adoption burn-down. Untagging an edge is the human act of blessing it as intended architecture; `--no-drift` emits plain relationships instead. The draft is a starting point to rewrite, never a sync: rename the elements, write the real descriptions, split what a directory lumps together. It writes into the configured model directory only when no model file exists there. If one does, it prints the draft to stdout and says why, same never-overwrite rule as `init`.

A clean run prints a summary and exits 0. A file in `src/core` importing from `src/interface` is a dependency the model does not declare, so the run exits 1:

```text
error (1)
  relationship-direction  acme.app.core depends on acme.app.interface, but the model declares only acme.app.interface -> acme.app.core. Declare the dependency that the code actually has.
    architecture-rules  architecture-rules/relationship-direction/acme.app.core->acme.app.interface
    src/core/bad.ts:1  ../interface/index.ts
```

That exit 1 is the product: the gate that fails exactly where code and contract disagree.

## Configuration

`--json` emits the full result instead of the report. `--config <path>` overrides discovery, which otherwise checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, then `fitc4.config.json`, first in the working directory and then under `.fitc4/`, repeating up each ancestor. Two configs in one directory is an error rather than a silent choice.

The module forms default-export the same fields (wrap them in `defineConfig` for editor types) plus optional provider arrays. That is how the agent providers below are composed in. They load as ES modules, so in a CommonJS package (no `"type": "module"`), name the config `fitc4.config.mts`. If your tsconfig typechecks the config file, keep `skipLibCheck: true`. LikeC4's own declarations do not pass a strict lib check.

The optional `viewerBaseUrl` links findings into a published LikeC4 viewer. Publish one with `likec4 build --use-hash-history -o <dir>` to any static host (GitHub Pages works) and set `viewerBaseUrl` to where it is served, ending in `#/` for a hash-history build. Each finding in `--json` then carries a `link` to the most specific view showing the elements involved, the index view otherwise, so a finding pasted into an issue lands on the diagram. The text report only adds a `viewer:` footer line. With no host, `likec4 build --output-single-file` makes a single HTML file that works as a CI artifact.

## Rules

| Rule | Severity | Meaning |
|---|---|---|
| `unmapped-source` | warning | A source file is owned by no model element |
| `ambiguous-source` | error | Two elements claim the same source file |
| `missing-relationship` | error | Code crosses a boundary the model does not declare |
| `relationship-direction` | error | The model declares only the opposite direction |
| `unresolved-import` | warning | An import resolves to nothing, so it cannot be checked. Look for a broken path, a dead tsconfig alias, or an undeclared package |
| `drift-relationship` | info | Code still exercises a drift-tagged relationship; burn it down, then delete the relationship |
| `unused-drift` | warning | A drift-tagged relationship no code exercises anymore; delete it from the model |
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

Four more rules appear only when the [agent providers](#agent-providers) are composed in. Their severity follows the emitting provider's `severity` option, and the defaults below are the advisory defaults:

| Rule | Severity | Meaning |
|---|---|---|
| `ownership-suggestion` | info | The ownership advisor suggests an element for an unowned file, or says the model is missing one |
| `description-drift` | warning | The semantic review judges an element's code to contradict its described responsibility |
| `agent-unavailable` | warning | An agent provider's CLI failed or is not installed. Rises to error for a gating provider, which must not pass when its judge is absent |
| `agent-truncated` | info | An agent provider hit a configured input limit and announces what it did not review. Rises to error for a gating provider |

An element with no `sources` is legal: a grouping element, or a component implemented elsewhere. An unowned *file* is a finding; an unowned *element* is not. Legal, but not invisible. One `unobserved-elements` info finding per run lists the leaf elements with neither `sources` nor `packages`, so deliberate abstraction stays visible rather than accidental. A relationship declared between two parents covers traffic between their descendants. The scan excludes test files, by filename and by directory.

A `sources` entry containing `#` is a fragment claim, `<file path>#<fragment>`: ownership of a region inside one file, for domains where several elements live in a single file, like a compose file declaring every service of a stack. A scanner that emits subjects of the form `<path>#<fragment>` (the agent scanner accepts them on `file` refs) resolves against fragment claims by the same longest-claim rule; the fragment's dots play the trailing slash's role, and an unclaimed fragment falls back to whichever element owns the file. A fragment claim nothing observes inside an examined file is `unmatched-sources`, same as a directory prefix matching no scanned file.

Above five `unmapped-source` findings the report renders one grouped block: the total, a by-directory breakdown, and the first ten paths. A brownfield repository's unowned files are one adoption fact, not hundreds. `--json` is unchanged and keeps every finding.

The severities above are defaults, not policy. In a `.ts` config:

```ts
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

promotes new unowned code from a nudge to a gate failure. That is worth doing once adoption is finished, since dependencies from unowned files are never boundary-checked. It also turns a typo'd `sources` metadata key loud: LikeC4 metadata is freeform, so `source` is silently valid and just leaves the element owning nothing.

Type-only imports get their own policy. The scanner knows when a crossing is erased at compile time (`import type { X }`, `import { type X }` with only type specifiers, `export type { X } from`), and an edge counts as type-only only when every dependency behind it is; a mixed import like `import { type X, y }` is a value import. `architectureRules({ typeOnlyImports })` decides what that means: the default `'enforce'` keeps the standard severities but appends `(type-only)` to the boundary finding, `'info'` downgrades `missing-relationship` and `relationship-direction` on purely type-only edges to info, and `'ignore'` drops them. Ignored means not counted anywhere: under `'ignore'` a type-only import also stops exercising a drift-tagged relationship, so a drift edge kept alive only by type imports reports as `unused-drift`.

## Tolerated drift

A brownfield codebase fails a truthful model on day one. The escape hatch is not a baseline file. It is the model itself: declare the dependencies that really exist and tag them as drift.

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

A drift-tagged relationship is a declared relationship, so the code it covers is permitted. Permitted and counted. Each exercised drift edge is one `drift-relationship` info finding, and the report carries a burn-down line:

```text
info (1)
  drift-relationship  acme.app.core -> acme.app.interface is declared drift; 1 dependency still rides it. Remove the code path, then delete the tagged relationship from the model.
    architecture-rules  architecture-rules/drift-relationship/acme.app.core::_::acme.app.interface
    src/core/bad.ts:1  ../interface/index.ts

drift: 1 declared, 1 exercised, 0 unused
```

When the last code path dies, the edge flips to an `unused-drift` warning whose only fix is deleting the relationship. A drift edge the code no longer exercises must be deleted, so declared drift can only shrink. Tolerated debt cannot quietly persist. It lives in model text, visible in the diagram and reviewed in diffs, not in a generated baseline file. The edge is the unit: a drift relationship is one finding whether one import rides it or forty, so the dependency count it reports is informational, not gated. The tag is `drift` by default (`architectureRules({ driftTag })` changes it) and must be declared in the specification, since LikeC4 rejects unknown tags. `severity: { 'drift-relationship': 'error' }` forbids tolerated drift entirely; `{ 'unused-drift': 'error' }` makes a dead drift edge fail the build until someone deletes it.

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

A claim is an exact npm package name, like `pg` or `@aws-sdk/client-s3`. It takes a string or an array, same as `sources`, and imports of any subpath map onto the claim. An import of a claimed package resolves onto the claiming element, and the standard relationship rules then judge the edge exactly like a file-to-file crossing. "Only infra may import `pg`" is nothing more than the absence of a declared relationship from anywhere else. Unclaimed packages stay unrestricted, and the claims are fail-closed like `sources`: `invalid-packages`, `ambiguous-package`, and `unmatched-packages` are errors, never silent no-ops.

## As a library

Everything the CLI does is reachable from the package entry point, so you can assert on architecture inside your own test suite instead of shelling out.

```ts
import { findConfig, resolveConfig, pipelineConfig, runPipeline, exitCodeFor } from 'fitc4'

const result = await runPipeline(pipelineConfig(await resolveConfig(findConfig(process.cwd()))))
expect(exitCodeFor(result)).toBe(0)
```

`resolveConfig` loads all three config forms; `loadConfig` is the synchronous, JSON-only variant.

Providers are plain functions composed into phase arrays: `ScanProvider`, `ResolveProvider`, `ValidateProvider`. `pipelineConfig` is the batteries-included default; to swap a scanner, build your own `PipelineConfig` and pass it to `runPipeline`.

Every CLI run narrates its progress to stderr, one plain line per phase and provider (`scan: typescript-imports...`), so a long scan or a slow agent call never looks hung; `--quiet` turns it off, and the report and `--json` on stdout are byte-identical either way. As a library, pass `onProgress: (message) => ...` in the `PipelineConfig` (or in `draft`'s options) to receive the same lines. Provider contexts carry an optional `progress` hook the pipeline injects, prefixed with the provider id.

## Agent providers

`fitc4/agent` adds providers that shell out to your locally installed agent CLIs (`claude`, `codex`). Your login, your billing, no API keys in fitc4. `agentOwnershipAdvisor` suggests an owner for every file the model leaves unowned; `agentSemanticReview` judges whether an element's implementation still matches its declared description. Agent findings are additive, and each provider takes a `severity`: advisory by default, part of the gate when you choose `'error'`. At `'error'` a missing or logged-out CLI fails the build instead of being a `warning` nudge. `cached()` makes reruns with unchanged inputs free and identical.

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

Judgment quality is measured, not assumed. Against planted ground truth in [`evals/`](https://github.com/arocnies/fitc4/tree/main/evals), `sonnet` and `gpt-5.6-luna` both score a perfect 35/35 across the full suite, checked-in and external fixtures alike (measured 2026-08-21). The cheap-model failure mode is measured too, and it runs in both directions: `haiku` over-reports, and it also under-reports on subtle single-line signals in large files. In the same run its scan missed a planted one-line violation, which then passed the gate undetected. An extra is noise a human dismisses; a scan miss is fail-open, invisible to the gate by construction. That asymmetry is the measured argument for keeping the validate providers advisory by default and for graduating proven domains to deterministic providers.

The same entry point ships `agentScan` and `agentResolve`. `agentScan` is a scan provider driven by prose instructions, so it can enforce model domains no parser covers: compose files, runbooks, OpenAPI. `agentResolve` maps external and unresolvable dependencies onto model elements, including description-only ones like an external system. Unlike the advisory validate providers these are load-bearing, so they fail closed: any exec failure, off-schema reply, or hallucinated path is a `provider-failure` error, never a quietly thinner run. Model choice follows the same split. `haiku`, the `claudeCli` default, is fine for the advisory tier, whose failure mode is noise; for a fail-closed scan that gates a merge, the measured recommendation is a model that scored perfect in the suite, `codexCli({ model: 'gpt-5.6-luna' })` or `claudeCli({ model: 'sonnet' })`, after the 2026-08-21 eval run in which haiku's scan missed a planted one-line violation (supabase's enabled `auth -> functions` send-email hook) and the gate passed it undetected. They are the prototyping path for new model domains. Prose explores, and a proven domain graduates to a small deterministic provider. Details: [`docs/agent-providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/agent-providers.md).

## For AI agents

FitC4's agent interface is the CLI itself: run it, read the report, fix what it names. Failing reports link back to the rules table above, and `--json` emits the full pipeline result for structured consumption, typed as the `PipelineResult` shipped in `dist/index.d.ts`. FitC4 is the *enforcement* half of the ecosystem's AI story: for querying a LikeC4 model, LikeC4 ships an MCP server (`npx likec4 mcp`), and for writing the DSL there is the LikeC4 agent skill (`npx skills add https://likec4.dev/`).

The one norm an agent cannot infer from the CLI: **the model is the contract. Editing it to permit whatever the code does is the cheapest path to a green build, and it defeats the tool.** If agents work in your repository, add this to your `AGENTS.md` or `CLAUDE.md`:

```markdown
## Architecture gate (fitc4)

- Run `npm run fitc4` before handing off changes; it checks the code against
  the LikeC4 architecture model. Exit 1 is an architecture violation, not a
  flaky tool.
- A finding means the code and the contract disagree. Fixing the code is the
  default. Editing the model is a design decision. It is legitimate when the
  architecture genuinely changed, never merely to silence a finding. Call out
  any model change explicitly when handing off.
- Never delete `sources` metadata or a declared relationship to make a finding
  go away. That removes code from architecture control entirely.
- Rule reference: `node_modules/fitc4/README.md#rules`. Structured output:
  `npx fitc4 --json`.
```

`npx fitc4 init` scaffolds an `AGENTS.md` carrying these norms; the block above is for merging them into a file you already have.

The package also ships a Claude Code skill at `skills/fitc4/` covering the full fit workflow: reading severities, when a model edit is legitimate, drift etiquette. Copy it into your project's `.claude/skills/fitc4/`, or reference it in place from `node_modules/fitc4/skills/fitc4/`.

## Links

Source, issues, a full worked example, and the provider contract live in the [GitHub repository](https://github.com/arocnies/fitc4). See [`example/`](https://github.com/arocnies/fitc4/tree/main/example) and [`docs/providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/providers.md). Checking JavaScript or mixed JS/TS projects? The companion package [`fitc4-dependency-cruiser`](https://github.com/arocnies/fitc4/tree/main/packages/fitc4-dependency-cruiser) wraps dependency-cruiser as a scan provider. Install both and compose it in config.
