# FitC4

Fit the code to the model: check an implementation against a LikeC4 architecture contract.

A [LikeC4](https://likec4.dev) model is a user-defined contract. It says which components exist and which may depend on which. `fitc4` is the enforcement half of LikeC4: it scans your code, maps every file and import onto that model, and fails the build where the two disagree.

- **A deterministic CI gate.** fitc4 checks imports against declared relationships. Same inputs, same findings, exit 1 on violation. TypeScript imports are what it checks out of the box. Providers extend the same gate to anything else observable about the implementation, such as compose files, runbooks, or OpenAPI specs.
- **A way in for brownfield code.** A truthful model fails on day one. [Tolerated drift](#tolerated-drift) declares the debt in the model, counts it in every report, and only lets it shrink.
- **A contract agents are held to.** Agents write more of the code now. fitc4 holds them to the same model through the same CLI, and ships the norms that keep "edit the model to silence the finding" off the table. See [For AI agents](#for-ai-agents).

## Quickstart

```sh
npm install --save-dev @arocnies/fitc4
npx fitc4 init
```

`init` writes three files and never overwrites an existing one: `fitc4.config.mts`, a starter `arch/model.c4` whose single element owns `src/**` so the very first check is green, and an `AGENTS.md` carrying [the norms](#for-ai-agents). Split the placeholder into real components from there, or let [`draft`](#draft-a-model-from-existing-code) replace it wholesale.

On a brownfield repository the whole path to green is five commands and one edit:

```sh
npm install --save-dev @arocnies/fitc4
npx fitc4 init --agent codex     # or claude; plain init scaffolds the gate without agents
npx fitc4 draft                  # writes a model from your code
                                 # then edit arch/model.c4: untag the edges you bless
npx fitc4
```

**With `--agent claude` or `--agent codex`**, the scaffolded config declares one shared cached exec around that CLI's measured model as its `agent`, so [`draft`](#draft-a-model-from-existing-code) describes each element immediately, and composes the [agent providers](#agent-providers) into the phases: `agentResolve` in resolve, the two advisory providers in validate. The scan phase follows the directory: with a `tsconfig.json` it is the deterministic TypeScript scanner; without one it is `importScan()`, the built-in deterministic import crawler (Python, JS/TS, Go, Rust, Java, Kotlin, Ruby, C/C++), so a repository in any of those languages works from init onward with no per-run agent cost; and only a directory holding none of them falls back to `agentScan({ exec })`, whose general import scan reads anything. The exec runs your own CLI on your own login and billing, and `agentResolve` is fail-closed, so every `fitc4` run calls the CLI and a run without a login fails. Each provider's cost is commented beside it in the scaffold; remove the ones your CI cannot carry, or keep a deterministic config for CI beside it (below). Everything else init does is identical.

**Requirements.** Node >= 22.22.3, since the CLI loads `.ts` configs with Node's native type stripping. The TypeScript scanner also needs a `tsconfig.json`, whose module resolution it uses; `importScan` and the agent providers need nothing.

**Install weight.** `fitc4`'s own build is under 1 MB, but it depends on `likec4` for model parsing, and that package is a CLI and dev server as well as a library, so a fresh install lands around 138 MB: likec4's `@likec4/icons`, `esbuild`, `vite`, `rolldown`, and `playwright` come along for a scan that touches none of them. The dependency is a caret range (`^1.59.2`) so it dedupes with the likec4 your project already installs, which is the common case for a repository that authors LikeC4 models, and an advisory CI leg runs the suite against `likec4@latest` so skew with new releases surfaces there rather than in your install.

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

**`fitc4.config.mts`** at your project root. Paths resolve relative to this file, and the three phases are explicit: what runs is what the file names, nothing more.

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
})
```

**Run it.**

```sh
npx fitc4
```

Most projects add a `"fitc4": "fitc4"` script and run `npm run fitc4` in CI.

## Draft a model from existing code

`init` scaffolds a placeholder. `npx fitc4 draft` goes further on a brownfield repository: it runs the configured scan providers, no model needed, and writes a first-draft model from what they observed. The draft mirrors the structure the observations report, not the filesystem hierarchy: each scan root splits into its first-level directories, and below that a directory splits into nested elements when an observed dependency crosses between two of its subdirectories, at that level or anywhere deeper, and collapses into one element where none does, so the granularity comes from the code's own dependency graph rather than a folder convention. The recursion matters for hub-and-spoke packages: a top package whose subpackages only import its own root files still splits, because the observed architecture lives inside a subpackage below it. One relationship covers each observed cross-element dependency, labeled with the observed count so the diagram says how much traffic an edge carries, and one stub element claims every observed external package so the resolve tier is quiet on day one. The views come drafted too: an index over the top level, plus one drill-down view per element that contains elements, so the viewer opens as a gallery and scoping into a component is one click rather than a trip through the relationship browser. It consumes the observation contract, not TypeScript specifics, so it drafts from whatever scan providers the config composes, `@arocnies/fitc4-dependency-cruiser` and the agent scanners included. On a brownfield repository the scan that carries the draft is usually `importScan`, deterministic and sub-second at any repository size; drafting with agent scan providers needs the agent CLI available.

Two more shapes fall out of the same principle. A scan that reports fragment locators (`docker-compose.yml#services.auth`) gets one element per observed fragment, nested under an element for the containing file and claiming the locator verbatim, so a whole service stack drafted from one compose file arrives as one element per service. And a dependency target of a domain-specific kind (a `system`, a `service`) becomes a description-only boundary element beside the package stub, with a plain declared edge; the gate cannot resolve anything onto such an element yet, so tagging that edge as drift would only create noise.

Every relationship the gate can observe is tagged as drift by default, so the very first gate run is green and the drift line becomes the adoption burn-down. Untagging an edge is the human act of blessing it as intended architecture; `--no-drift` emits plain relationships instead. The draft is a starting point to rewrite, never a sync: rename the elements, write the real descriptions, split what a directory lumps together.

It never overwrites an authored model, with one exception: `init`'s untouched placeholder, recognized by the marker comment on its first line, is replaced (edit the placeholder and it is yours; draft leaves it alone). A drafted model carries no marker, so a second draft over it refuses. When the draft refuses, stdout carries the model text and nothing else, so `fitc4 draft > arch/model.c4` writes a clean file; the reason and the counts go to stderr.

When the config declares an `agent` exec, the draft also describes: each eligible element's TODO description is replaced with one or two sentences the exec proposes from the files that element owns (eligible means a `sources` claim plus at least one observed file). Pure containers are described too, after their children, from the children's fresh descriptions rather than from files, so the top of the drafted tree does not sit as a TODO over described leaves; only the boundary and vendor stubs keep their placeholders, since their whole description is an instruction to the human. `init --agent` scaffolds the exec; `--no-describe` skips the pass and drafts deterministically; `--describe` on an agentless config fails loudly instead of drafting placeholders. A model that abstains leaves that element's TODO in place and the draft still succeeds; an exec that cannot run at all (missing CLI, not logged in, timeout, off-schema reply) aborts the draft, exits nonzero, and writes nothing. The calls run four at a time, so a first draft costs minutes, not one round trip per element. The pass is skipped entirely when the draft would refuse to write, so nobody is billed for descriptions that get thrown away. The proposals are draft-time only: the gate critiques descriptions (`agentSemanticReview`), it never rewrites them.

A clean run prints a summary and exits 0. A file in `src/core` importing from `src/interface` is a dependency the model does not declare, so the run exits 1:

```text
error (1)
  relationship-direction  acme.app.core depends on acme.app.interface, but the model declares only acme.app.interface -> acme.app.core. Reroute or remove the import so the dependency flows the way the model declares.
    architecture-rules  architecture-rules/relationship-direction/acme.app.core->acme.app.interface
    src/core/bad.ts:1  ../interface/index.ts
```

That exit 1 is the product: the gate that fails exactly where code and contract disagree.

## Configuration

`--json` emits the full result instead of the report. `--config <path>` overrides discovery, which otherwise checks `fitc4.config.ts`, `.mts`, `.js`, `.mjs`, first in the working directory and then under `.fitc4/`, repeating up each ancestor. Two configs in one directory is an error rather than a silent choice.

The config default-exports its fields (wrap them in `defineConfig` for editor types), and the `scan`/`resolve`/`validate` arrays are required: there are no default phases, no merge semantics, and nothing composed in behind the file. A missing phase is an error carrying the standard composition ready to paste. The file loads as an ES module, so in a CommonJS package (no `"type": "module"`), name it `fitc4.config.mts`. If your tsconfig typechecks the config file, keep `skipLibCheck: true`. LikeC4's own declarations do not pass a strict lib check.

Rule tuning lives on the rules provider, in your own `validate` array:

```ts
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

The [standard severities](#rules) assume adoption: new unowned code is a `warning` nudge rather than a broken build. That map is how a team done adopting closes the door, and unowned code fails the gate from then on. `{ 'unused-drift': 'error' }` means a drift edge the code no longer exercises fails until it is deleted from the model, so [declared drift](#tolerated-drift) can only shrink. An unknown rule id is an error at load time, not an ignored key, because a typo'd promotion that silently does nothing is a team believing their gate is closed when it is open.

**Other languages.** `importScan()` is the built-in deterministic scanner for everything the TypeScript scanner cannot read: it walks its `roots` (default: the repository), extracts imports lexically for Python, JS/TS, Go, Rust, Java, Kotlin, Ruby, and C/C++, resolves repository-local imports against the file tree, and reports external packages by each ecosystem's claimable name (Python's top-level module, Go's module path from `go.mod`, the specifier as written for JS), so [`packages` claims](#package-claims) work naturally. Standard-library imports stay out: the runtime is not part of the architecture. Test files, `node_modules`, hidden directories, root-level build output, and root-level tooling configs (`vite.config.ts` and friends) are skipped. `ignore` adds what only the repository knows, as paths or globs (`*` within a segment, `**` across, a bare path covering its subtree), which on a brownfield repository is usually a second copy of the source: a scratch tree, a vendored fork, a generated client. An ignored path leaves the file tree the resolver matches against, so an import into one leaves the repository too, as a claimable external module or an unresolved dependency depending on how the language names it. It is lexical on purpose: a TypeScript project with tsconfig path aliases belongs to `typescriptImports`, domains no parser covers belong to [`agentScan`](#agent-providers), and running `importScan` beside `typescriptImports` over the same roots would observe the same imports twice.

**Mixing scanners.** `scan` is a list, and every provider in it feeds the same pool of observations, so a deterministic scanner and an agent one belong in the same config whenever both have something to say. The overlap is harmless by construction: the pipeline namespaces each observation with the id of the provider that emitted it, so two scanners seeing the same import never collide, and the rules key findings by the elements involved rather than by the observation, so that import stays one finding carrying both citations. Point each scanner at what only it can read. `typescriptImports` goes where a tsconfig resolves path aliases, `importScan` covers the other languages in the tree, and [`agentScan`](#agent-providers) takes the domains no parser covers, such as compose files, infrastructure, or docs. Safe is not free: the agent scanner costs a call per batch on every uncached run, and a drafted edge's count label tallies an import once per scanner that saw it. Compose one `importScan` or `typescriptImports` per set of roots. Neither takes an `id` suffix, so two instances over overlapping roots emit colliding observation ids, while `agentScan` does take `id` and several instances with different instructions coexist.

**Monorepos and non-`src/` layouts.** `init` detects the conventional source directories that actually exist and hold code (`src`, `lib`, `app`, `packages`, `services`, and friends) and scaffolds `roots` from them; a repository using none of them scans from the repository root, minus the standard skip list, so the first run works on any layout. When the detection is wider or narrower than what you want under architecture control, `roots` is the one edit to make before drafting. Point `roots` at the directories under architecture control (`roots: ['packages/api/src', 'packages/web/src']`, or `roots: ['lib']`), and `tsconfig` at whichever tsconfig resolves those files' imports. One config at the repository root with several roots gives one model governing the cross-package boundaries, which is usually the point of adopting; a workspace that wants its own model instead gets its own config and model directory, discovered when fitc4 runs from inside it. This repository self-hosts per package that way. The scanner has one tsconfig per `typescriptImports` provider, so a monorepo whose packages resolve through different path aliases composes the scanner once per tsconfig: `scan: [typescriptImports({ tsconfig: 'packages/api/tsconfig.json', roots: ['packages/api/src'] }), typescriptImports({ ... })]`.

The optional `viewerBaseUrl` links findings into a published LikeC4 viewer. Publish one with `likec4 build --use-hash-history -o <dir>` to any static host (GitHub Pages works) and set `viewerBaseUrl` to where it is served, ending in `#/` for a hash-history build. Each finding in `--json` then carries a `link` to the most specific view showing the elements involved, the index view otherwise, so a finding pasted into an issue lands on the diagram. The text report only adds a `viewer:` footer line. With no host, `likec4 build --output-single-file` makes a single HTML file that works as a CI artifact.

## Rules

| Rule | Severity | Meaning |
|---|---|---|
| `unmapped-source` | warning | A source file is owned by no model element |
| `ambiguous-source` | error | Two elements claim the same source file |
| `missing-relationship` | error | Code crosses a boundary the model does not declare |
| `relationship-direction` | error | The model declares only the opposite direction |
| `unresolved-import` | warning | An import resolves to nothing, so it cannot be checked. Look for a broken path, a dead tsconfig alias, or an undeclared package |
| `unmapped-reference` | warning | A dependency named its endpoints in words that map onto no element — not a claimed path, not an element name — so the edge cannot be checked |
| `drift-relationship` | info | Code still exercises a drift-tagged relationship; burn it down, then delete the relationship |
| `unused-drift` | warning | A drift-tagged relationship no code exercises anymore; delete it from the model |
| `unobserved-elements` | info | Leaf elements with neither `sources` nor `packages`; nothing checks them |
| `invalid-sources` | error | Ownership metadata the prefix matcher cannot honour |
| `unmatched-sources` | error | Ownership metadata that matches no scanned file |
| `invalid-packages` | error | A `packages` claim that is not an exact npm package name |
| `ambiguous-package` | error | Two elements claim the same package |
| `unmatched-packages` | error | A claimed package that no scanned file imports |
| `circular-dependency` | warning | The code exercises a dependency cycle whose every edge the model declares — the one dependency defect each per-edge rule passes quietly (a cycle containing an undeclared edge already fails through `missing-relationship`). One finding per tangle, naming a witness cycle |
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

A `sources` entry containing `#` is a fragment claim, `<file path>#<fragment>`: ownership of a region inside one file, for domains where several elements live in a single file, like a compose file declaring every service of a stack. A scanner that emits subjects of the form `<path>#<fragment>` resolves against fragment claims by the same longest-claim rule; the fragment's dots play the trailing slash's role, and an unclaimed fragment falls back to whichever element owns the file. A fragment claim nothing observes inside an examined file is `unmatched-sources`, same as a directory prefix matching no scanned file — unless resolution reached the claiming element some other way, because the rule exists to catch a locator that silently gates nothing, not to police which vocabulary the scan spoke.

A dependency's endpoints resolve by their id, not by the ref kind the scanner chose. An agent describing a compose service naturally writes `{ kind: 'service', id: 'checkoutservice' }`, and demanding it say `file` instead would be prompt discipline for the tool's convenience. The id resolves as a claimed path or fragment first, then as an element name: the full LikeC4 id or its leaf, verbatim or spelling-insensitively (`redis-cart` finds the `redis_cart` identifier LikeC4 forced, `api-gw` finds `apiGw`). A name two elements share resolves as ambiguous and is reported, never guessed. `module` refs are exempt from name matching — a package spelled like an element is a coincidence, not an address. This is what lets an element with no `sources` at all, a description-only stand-in for something no code implements, still participate in checked edges: the scan names it, and the declared relationships judge the edge like any other.

Above five `unmapped-source` findings the report renders one grouped block: the total, a by-directory breakdown, and the first ten paths. A brownfield repository's unowned files are one adoption fact, not hundreds. `--json` is unchanged and keeps every finding.

The severities above are defaults, not policy. On the rules provider, in your config's `validate` array:

```ts
validate: [architectureRules({ severity: { 'unmapped-source': 'error' } })]
```

promotes new unowned code from a nudge to a gate failure. That is worth doing once adoption is finished, since dependencies from unowned files are never boundary-checked. It also turns a typo'd `sources` metadata key loud: LikeC4 metadata is freeform, so `source` is silently valid and just leaves the element owning nothing.

One more rule is opt-in rather than part of the standard gate. `missingDescriptions()` (add it: `validate: [architectureRules(), missingDescriptions()]`) emits one `missing-description` info finding per model element whose description is absent, empty, or still a scaffolded `TODO`. Opt-in because a description is documentation, not structure; what it buys a team that wants it is countability, the documentation burn-down the same way the drift line counts declared debt. Pairs with the draft's describe pass, which proposes first descriptions, and `agentSemanticReview`, which critiques stale ones.

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

When the last code path dies, the edge flips to an `unused-drift` warning whose only fix is deleting the relationship. A drift edge the code no longer exercises must be deleted, so declared drift can only shrink. Tolerated debt cannot quietly persist. It lives in model text, visible in the diagram and reviewed in diffs, not in a generated baseline file. The edge is the unit: a drift relationship is one finding whether one import rides it or forty, so the dependency count it reports is informational, not gated. The tag is `drift` by default (`architectureRules({ driftTag })` changes it, and `fitc4 draft --drift-tag <tag>` drafts with the same custom tag) and must be declared in the specification, since LikeC4 rejects unknown tags. `severity: { 'drift-relationship': 'error' }` forbids tolerated drift entirely; `{ 'unused-drift': 'error' }` makes a dead drift edge fail the build until someone deletes it.

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
import { findConfig, resolveConfig, runPipeline, exitCodeFor } from '@arocnies/fitc4'

const result = await runPipeline(await resolveConfig(findConfig(process.cwd())))
expect(exitCodeFor(result)).toBe(0)
```

Providers are plain functions composed into phase arrays: `ScanProvider`, `ResolveProvider`, `ValidateProvider`. A loaded config is already a `PipelineConfig`, so `runPipeline` takes it directly; to swap a scanner, name a different one in `scan`, or build the `PipelineConfig` in code and skip the config file entirely.

Every CLI run narrates its progress to stderr, one plain line per phase and provider (`scan: typescript-imports...`), so a long scan or a slow agent call never looks hung; `--quiet` turns it off, and the report and `--json` on stdout are byte-identical either way. As a library, pass `onProgress: (message) => ...` in the `PipelineConfig` (or in `draft`'s options) to receive the same lines. Provider contexts carry an optional `progress` hook the pipeline injects, prefixed with the provider id.

## Agent providers

`@arocnies/fitc4/agent` adds providers that shell out to your locally installed agent CLIs (`claude`, `codex`). Your login, your billing, no API keys in fitc4. `agentOwnershipAdvisor` suggests an owner for every file the model leaves unowned; `agentSemanticReview` judges whether an element's implementation still matches its declared description, four judgments in flight at a time, findings reported in element order regardless of completion order. Agent findings are additive, and each provider takes a `severity`: advisory by default, part of the gate when you choose `'error'`. At `'error'` a missing or logged-out CLI fails the build instead of being a `warning` nudge. `cached()` makes reruns with unchanged inputs free and identical.

A complete config:

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import { agentOwnershipAdvisor, agentSemanticReview, cached, claudeCli } from '@arocnies/fitc4/agent'

const agent = cached(claudeCli({ model: 'haiku' }))

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [
    architectureRules(),
    agentOwnershipAdvisor({ exec: agent }),
    agentSemanticReview({ exec: agent }),
  ],
})
```

The advisor makes zero calls on a clean repository; the review makes one call per described element (cached after the first run), and skips elements whose description is absent, empty, or still a `TODO`, since a placeholder is a known-absent description the deterministic `missing-descriptions` rule already counts.

Composing agent providers into the discovery-named config, as `init --agent` does, makes every plain `npx fitc4` call your CLI, which bills per run and, for the fail-closed `agentResolve`, fails in CI without a login. The pattern for a team whose CI carries no CLI login is a split: a deterministic discovery config for CI, and a config like the one above in a non-discovery filename run on demand with `--config`.

Judgment quality is measured, not assumed. Against planted ground truth in [`evals/`](https://github.com/arocnies/fitc4/tree/main/evals), `sonnet` and `gpt-5.6-luna` both score a perfect 35/35 across the full suite, checked-in and external fixtures alike (measured 2026-08-21). The cheap-model failure mode is measured too, and it runs in both directions: `haiku` over-reports, and it also under-reports on subtle single-line signals in large files. In the same run its scan missed a planted one-line violation, which then passed the gate undetected. An extra is noise a human dismisses; a scan miss is fail-open, invisible to the gate by construction. That asymmetry is the measured argument for keeping the validate providers advisory by default and for graduating proven domains to deterministic providers.

Descriptions are measured the same way, on a fixture built to be losable: directories whose names mislead, where a description assembled from the name fails the row instead of passing for being non-empty. `sonnet` and `gpt-5.6-luna` pass it; `haiku` described the entry point's mechanics accurately and never mentioned that it is the entry point, which is the fact an architecture model needs (measured 2026-08-22). Same run, the other direction: `gpt-5.6-luna` called a ledger immutable, and `agentSemanticReview` reported that the code stored the caller's mutable reference. It was right, and the fixture's code was wrong.

The same entry point ships `agentScan` and `agentResolve`. `agentScan` is a scan provider driven by prose instructions, so it can enforce model domains no parser covers: compose files, runbooks, OpenAPI, languages `importScan` does not read. Its instructions default to the general import scan (files, imports, standard library skipped), so `agentScan({ exec })` with nothing written is a working scanner anywhere; for the languages `importScan` reads, the crawler observes the same imports deterministically and free, so reach for `agentScan` where no parser does. A listing beyond `batchFiles` (default 25) splits into batches partitioned along the directory tree, so each call covers one coherent module rather than an alphabetical shard, and the batches run concurrently (default 4 in flight; `concurrency: 1` for sequential) because one reply cannot honestly carry a whole repository and the batches are disjoint areas with nothing to coordinate; with `cached()` every completed batch is recorded as it finishes, so an interrupted scan resumes at the first unanswered batch. `agentResolve` maps external and unresolvable dependencies onto model elements, including description-only ones like an external system. Unlike the advisory validate providers these are load-bearing, so they fail closed: any exec failure, off-schema reply, or hallucinated path is a `provider-failure` error, never a quietly thinner run. Model choice follows the same split. `haiku`, the `claudeCli` default, is fine for the advisory tier, whose failure mode is noise; for a fail-closed scan that gates a merge, the measured recommendation is a model that scored perfect in the suite, `codexCli({ model: 'gpt-5.6-luna' })` or `claudeCli({ model: 'sonnet' })`, after the 2026-08-21 eval run in which haiku's scan missed a planted one-line violation (supabase's enabled `auth -> functions` send-email hook) and the gate passed it undetected. They are the prototyping path for new model domains. Prose explores, and a proven domain graduates to a small deterministic provider. Details: [`docs/agent-providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/agent-providers.md).

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
- Never soften a rule's severity in the config, and never remove a provider
  from a phase, to make a finding go away. How strict the gate is belongs to
  the team; loosening it for a green run is the same evasion as deleting the
  relationship, one layer up.
- Rule reference: `node_modules/@arocnies/fitc4/README.md#rules`. Structured output:
  `npx fitc4 --json`.
```

`npx fitc4 init` scaffolds an `AGENTS.md` carrying these norms; the block above is for merging them into a file you already have.

The package also ships a Claude Code skill at `skills/fitc4/` covering the full fit workflow: reading severities, when a model edit is legitimate, drift etiquette. Copy it into your project's `.claude/skills/fitc4/`, or reference it in place from `node_modules/@arocnies/fitc4/skills/fitc4/`.

## Links

Source, issues, a full worked example, and the provider contract live in the [GitHub repository](https://github.com/arocnies/fitc4). See [`example/`](https://github.com/arocnies/fitc4/tree/main/example) and [`docs/providers.md`](https://github.com/arocnies/fitc4/blob/main/docs/providers.md). Checking JavaScript or mixed JS/TS projects? The companion package [`@arocnies/fitc4-dependency-cruiser`](https://github.com/arocnies/fitc4/tree/main/packages/fitc4-dependency-cruiser) wraps dependency-cruiser as a scan provider. Install both and compose it in config.
