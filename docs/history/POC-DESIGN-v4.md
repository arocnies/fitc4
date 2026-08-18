> **Historical design document**, superseded by [../DESIGN.md](../DESIGN.md); kept as the record of how the design evolved.

# Architecture Control Proof of Concept — Version 4

Status: implementation-ready amendment. This file is untracked.

This version is deliberately small. It keeps [`POC-DESIGN-v3.md`](./POC-DESIGN-v3.md) as the design of record — the pipeline, the three domain objects, the provider function types, and the non-goals are unchanged. Version 4 only records the decisions that were still open, corrects two claims made during review, and locks the scope of the first prototype.

## Version History

| Version | Main decision |
|---|---|
| 1 | Four phases, native LikeC4 validation, TypeScript/Git scanning, and JSON command boundaries |
| 2 | Compact architecture-level provider projections and validation-provider aggregation |
| 3 | Native LikeC4 model as the only model object, simple TypeScript provider functions, and opaque provider data |
| 4 | Verified toolchain decisions, `sources` metadata, stable identifiers, and a locked prototype scope |

## Verified Toolchain Facts

These were checked against the installed versions, not assumed.

**TypeScript 7.0.2 has no classic compiler API.** `createProgram`, `resolveModuleName`, and `createSourceFile` are all absent; the surface moved to `typescript/unstable/*`, where `Program` exposes source files and diagnostics but no module resolution.

Decision: the `arch` workspace takes `typescript@6.0.3` as a local devDependency for the scanner only. 6.0.3 ships the complete classic API. The root stays on 7.0.2 for `typecheck` speed. This is a temporary split, revisited when 7.1 lands its new compiler API.

**LikeC4 metadata supports lists.** The type is `string | NonEmptyArray<string>`. Two authoring forms parse:

```
metadata {
  sources ['src/api/**', 'src/api2/**']   // bracketed; commas required
}
metadata {
  sources 'src/core/**'                    // repeated key
  sources 'lib/core/**'                    // merges into an array
}
```

A bare comma without brackets does not parse, and neither does a bracketed list without commas.

**A single-element list collapses to a scalar.** `sources ['src/core/**']` reads back as the string `"src/core/**"`, not a one-element array. Normalization at the read boundary is therefore mandatory and cannot be avoided by an authoring convention.

**Relationship identifiers are generated hashes.** The same relationship surfaced as `g8faux` in one model and `8ivr3f` in another. They are not suitable as report keys.

## Decisions

### `sources` replaces `sourceRoot`

The ownership metadata key is `sources`. It holds one or more repository-relative directory prefixes, optionally ending in `/**`.

Every reader normalizes on ingest:

```ts
const sources = typeof raw === 'string' ? [raw] : raw ?? [];
```

`model.c4` still uses `sourceRoot` and needs the one-line rename before the resolver runs.

### An element with no `sources` is legal

A system-level grouping element, or a component implemented outside this repository, will have no ownership metadata. This is normal and is not itself a finding.

The rule is directional: **an unowned file is a finding; an unowned element is not.**

What the model cannot yet express is the difference between "deliberately not implemented here" and "someone forgot to map it." That likely wants an explicit marker eventually. It is not solved now — the prototype should report how often the ambiguity actually bites.

### Stable identifiers

Derived, human-readable, and stable under unrelated model edits.

| Thing | Identifier |
|---|---|
| Element | The LikeC4 FQN, used directly — author-controlled and already stable |
| Relationship | `${source.id}::${kind ?? '_'}::${target.id}` |
| Finding | `${provider}/${ruleId}/${stableSubjectKey}` |

Example: `acme.app.iface::imports::acme.app.core`.

An identifier changes only when someone renames a component, which is exactly when it should. The LikeC4 hash may be carried in `data` for traceability but never appears in a report key.

If LikeC4 permits duplicate source/kind/target triples in practice, append an ordinal. Confirm during the prototype rather than designing for it now.

### Minimal C4 vocabulary

Fixtures use `system`, `container`, and `component` only.

The real `model.c4` vocabulary is intentionally left unsettled. Deciding which element kinds matter before any rule consumes them produces kinds nothing reads. The rules will show which distinctions are load-bearing.

### The workspace owns its own tests

`arch` tests its own pipeline against fixture repositories under `arch/test/fixtures/`, using workspace-local `vitest` and `typecheck` scripts wired into `arch`'s `check`.

The tool must assume nothing about how a host project tests itself. Root `tsconfig.json` (`include: src/**/*.ts`) and the root `test` script (`vitest run src`) stay scoped to the host project and are not widened to cover `arch/src`.

### Failure semantics

Version 3 left these undefined. They block implementation, so they are fixed here.

- A provider that throws produces one `error` finding attributed to that provider. The pipeline continues and the process exits non-zero. This is more useful than aborting and exercises the same reporting path as every other finding.
- The core namespaces every incoming `id` with the emitting provider's id. Providers cannot collide with each other, and `file:src/index.ts` from two scanners stays distinct.
- `data` that is not JSON-serializable fails that provider, handled as a throw.
- `data` is read only by its emitting provider and by renderers that opt in via `ruleId`. Neither the core nor another provider may interpret it. Without this rule it silently becomes a shared schema.
- `Ref.kind` stays open, but `file`, `component`, `relationship`, and `observation` are reserved with the meanings from version 2.

### Context gaps

`ResolveContext` and `ValidateContext` gain `repositoryRoot` and `sources`. Version 2 relied on providers inspecting the repository directly to disambiguate; version 3 removed their ability to do so.

`ScanContext.changedPaths` is deferred along with git integration. It is not populated in the prototype.

## Prototype Scope

Build exactly this:

| Component | Role |
|---|---|
| `likec4-model` | `fromWorkspace` + `computedModel` + `getErrors`; gates the pipeline |
| `typescript-imports` | TS6 `createProgram` over the target tsconfig; imports and re-exports; `resolveModuleName` for targets |
| `source-root` | Normalize `sources`, prefix match, longest match wins, multiple matches are `ambiguous` |
| `architecture-rules` | `unmapped-source`, `ambiguous-source`, `missing-relationship`, `relationship-direction` |
| Two fixtures | One advisory finding; one that throws, to pin down failure semantics |

Deferred: command providers and `fitc4.config.json`, advisory-versus-blocking gating, git and `changedPaths`, Code-Graph-RAG, and the stability provider.

Stability is deferred despite being cheap. It is model-only, exercises no boundary the four rules do not already cover, and computes 0/1 against the current two-element model.

Version 3's gate policy — "external command providers are advisory by default" — has no mechanism to attach to once commands are deferred. It is inert until `fitc4.config.json` exists.

## Questions the Prototype Must Answer

1. **Does resolve earn its separation from validate?** Every rule currently re-derives what `source-root` already computed. If the validators ignore `Association[]` and walk observations directly, the pipeline is three phases, not four. This is the question the prototype exists to settle.
2. Does prefix matching on `sources` survive real use, or is a real glob implementation needed?
3. What is the false-positive rate of `missing-relationship` against actual code?
4. Can a renderer stay ignorant of `data` shapes once two providers emit it?
5. Which C4 element kinds do the rules genuinely need to distinguish?
6. How often does an unowned element need to be told apart from an unmapped one?

## What the Prototype Settled

Recorded after building the prototype and reviewing it against this document. These supersede the sections above where they differ.

### Resolve does not earn its separation as specified — Question 1

The first implementation had `architecture-rules` reading six keys out of `Association.data` that `source-root` had written, which is exactly the shared-schema failure this document forbids. The cause was structural, not careless: `Association` as defined in version 3 cannot carry what a validator needs. Three of the six keys were derivable from existing fields, but the ambiguity candidate list and the reverse-direction hint had nowhere to live.

The resolution keeps four phases but changes the contract:

- **`Association` gains `candidates?: Ref[]`** — the competing owners when `status` is `ambiguous`. First-class, because a validator must read it without knowing which resolve provider ran.
- **Derived facts stay derived.** "Internal" is `isSameOrNested(source.id, target.id)`; "declared" is `relationship !== undefined`; the file is the observation's `subject.id`.
- **A validator re-derives model questions from `ValidateContext.model`.** The reverse-direction check is a model query, not a resolve output.

**The prohibition on reading another provider's `data` is withdrawn.** `data` is meant to be flexible, and a provider that wants to consume another's payload may. What replaces the ban is a weaker but honest rule:

- **The core never interprets `data`.** It checks serializability and nothing else. That part is real and holds.
- **A provider reading another's `data` takes on a coupling it owns.** No version negotiation, no schema registry — if the producer changes shape, the consumer breaks, and that is the consumer's problem.
- **A rule that belongs to the contract belongs in the contract.** `candidates` became a first-class `Association` field because every validator needs it regardless of which resolve provider ran. Convenience goes in `data`; contract goes in the envelope.

The deterministic providers stay on the strict path — `architecture-rules` reads only `Association` fields and `ValidateContext.model` — because they are the reference implementation, not because the boundary is enforced.

Two limits worth naming:

- The coupling moved rather than vanished. `architecture-rules` still depends on `typescript-imports`' vocabulary in the *envelope* — `observation.kind` of `file`/`dependency`/`scan-root`, and `target.kind` of `unresolved`. That is a smaller and more visible surface than a `data` schema, not the absence of one.
- Whether four phases are worth this is still arguable. `Association` needed a new field to make the boundary hold once; it may need another.

### Ownership matching must reject what it cannot honour — Question 2

Prefix matching survives, but only with normalization and a refusal to guess. `./src/core/**`, `/src/core/**`, `src\core\**`, `src/core`, and `src/core/` all normalize to `src/core/`. Anything with a surviving wildcard, a filename, or an empty result is **rejected** and reported as `invalid-sources`.

This matters more than it sounds. Silently producing a prefix that matches nothing made the gate fail open: a stray `./` on every `sources` value turned three architecture errors into a clean exit 0, because every dependency became unresolvable and the only residual signal was a non-gating warning. Two invariants close it:

- `invalid-sources` (error) — a declared source the matcher cannot honour.
- `unmatched-sources` (error) — a declared source matching no scanned file.

The trailing slash on every prefix is load-bearing: without it, `src/` also claims `src-legacy/`.

The same fail-open exists on the other side of the comparison. A scan root that is missing, misspelled, or empty reduces coverage to nothing, and every violation disappears just as quietly. So the scanner refuses to run with no roots configured, with a root that is not a directory, or with a root holding no TypeScript.

Ownership is only judged where the scan actually looked. The scanner records each covered root as a `scan-root` observation, and `unmatched-sources` fires only for prefixes inside one. A component may legitimately own code outside the scan roots — the same legal state as an element with no `sources` — and reporting that would leave the author no fix but to delete truthful metadata.

### Containment is not optional

Exact source/target matching produced violations the author cannot fix. LikeC4 rejects a relationship between a parent and its own child, so a child importing from its parent failed the gate with no legal way to declare it. A relationship declared between two parents must also cover traffic between their descendants.

- An element and its own ancestor or descendant are one boundary, never a crossing.
- `hasRelationship` walks ancestor pairs, matching LikeC4's own containment semantics.

### Coverage must not depend on import reachability

A `Program` seeded from tsconfig contains only included files plus what they transitively import, so a file nobody imports was never observed and therefore never reported as unowned. The scanner now walks explicit **scan roots** on disk.

Scan roots are configured, not derived from the model: a file can only be reported as unowned if the scanner looked at it. `ScanContext.sourceRoots` is accordingly renamed `sources`, matching the metadata key.

`isExternalLibraryImport` is also the wrong test for "not our code" — an npm workspace package is reached through `node_modules` but lives in the repository. Repository membership decides.

### Duplicate relationship triples exist — confirmed

LikeC4 permits several relationships with the same source, target, and kind. They collapse onto one stable id. Rather than add an ordinal, the collision is surfaced as `duplicate-relationship` (info) and the first is used. No rule depends on telling them apart.

### Additional rules

Beyond the original four:

| Rule | Severity | Why |
|---|---|---|
| `unresolved-import` | warning | A relative import resolving to nothing leaves the check with nothing to test |
| `invalid-sources` | error | Ownership metadata the matcher cannot honour |
| `unmatched-sources` | error | Ownership metadata claiming no scanned file |
| `duplicate-relationship` | info | Two relationships sharing one stable identity |
| `orphaned-association` | error | Associations referencing observations that do not exist |

### Failure semantics, extended

- **Duplicate ids fail the emitting provider, and its output is discarded whole.** They silently overwrite in every downstream lookup. A provider that fails partway contributes nothing: half its output is not a result, it is a misleading one. The core's own scanner violated this twice — once before the id carried the reference line, and again for two references sharing one line.
- **`provider-failure` is attributed to the core**, naming the failing provider in the subject and description. The core did emit it. The phase is part of the id, so one provider id failing in two phases yields two findings.
- **JSON-safety is a round-trip check, not a `JSON.stringify` attempt.** `stringify` throws only on cycles, BigInt, and throwing getters; it silently discards `undefined`, functions, symbols, `Map`, and `Set`, and rewrites `NaN` to `null`.
- **An unrecognized severity is forced to `error`.** Otherwise it is dropped by the renderer, counted by nothing, and gates on nothing.
- **Associations are ided `file:${path}` or `dependency:${observationId}`**, and the renderer is the single definition of the gate, shared by the text and JSON paths.

### Test files are excluded from the scan

A test crossing a boundary is a testing decision, not a declared architectural dependency. Both filename (`*.test.ts`) and directory (`test/`, `__tests__/`) conventions count. This is a policy decision inside a scanner that is otherwise supposed to observe without interpreting — recorded here rather than left silent, and revisit it if it distorts Question 3.

### Relationships are untyped

The model uses plain `a -> b`, LikeC4's default, rather than a declared `relationship imports` kind. An observed TypeScript import carries no LikeC4 relationship kind, so `hasRelationship` ignores kind entirely and the declaration bought nothing but a line of specification. Kinds remain available if styling or filtering per kind later earns them.

Untyped relationships come back from the model API with `kind: null`, so their stable id is `source::_::target`. A typed relationship still embeds its kind, so adopting kinds later keeps distinct identities per kind rather than silently merging them.

### Configuration exists, providers are still code

`fitc4.config.json` now holds the project-specific inputs — `repositoryRoot`, `model`, `scanRoots`, `tsconfig` — with a `$schema` alongside it. Paths resolve relative to the config file, so moving the workspace cannot silently repoint the scan.

Validation is strict and hand-written: an unknown `version`, an empty `scanRoots`, a blank path, or malformed JSON is an error. A config that quietly fell back to defaults would scan the wrong tree and report a clean pass — the same fail-open this document keeps closing.

Command providers stay deferred. The provider arrays live in `cli.ts`, and configuring *which* providers run is a separate decision from configuring *where* they look.

### The kind vocabulary is a contract, and now says so

Version 3 left `Observation.kind` and `Ref.kind` open with a few names "reserved" in a comment. In practice `architecture-rules` switched on four bare string literals that `typescript-imports` happened to emit. That is a contract between two providers with no definition anywhere, and it fails in the worst available direction: a second scanner that emits `import` where the rules read `dependency` produces no findings and exit 0 — the same output a clean repository gets.

`src/kinds.ts` now names the standard set. Kinds stay open — a provider may emit its own, and two providers that understand each other's private kinds may cooperate without asking anyone. What the standard set buys is a default that works. An observation kind outside it is reported at `info` (`unknown-observation-kind`), one finding per kind per provider, so a vocabulary mismatch is visible without punishing private cooperation.

Three changes came out of writing the set down:

- `component` became `element`. An element that carries `sources` may be a container just as easily. The C4 kind belongs to the model; a copy of it in a `Ref` is a copy that eventually contradicts the original.
- `package` and `unresolved` collapsed into `module`. Whether a specifier resolved is a property of the observation, not of the id, so a resolution failure became its own observation kind — `unresolved-dependency` — rather than a ref kind meaning "this id is broken."
- `scan-root` as a *ref* kind became `directory`. `scan-root` is a role a directory plays in one provider's run, not a kind of thing an id points at. It survives as an observation kind, where it means "this is what I actually looked at."

`symbol` is reserved and unemitted. Naming it costs nothing and marks the obvious next axis — call graphs and public-API surfaces — as anticipated rather than accidental.

### Packaging — the tool separates from the project it checks

The prototype was one `arch` workspace holding both the engine and the model it checked. That conflation hid two defects that only exist once the tool is installed rather than colocated, so the split is now real:

```text
packages/fitc4/   the library and CLI
example/           a project it checks, standing in for a consumer
  fitc4.config.json
  arch/            model.c4, likec4.config.json
docs/              this file
```

`example` depends on `fitc4` as a workspace package and invokes it through `node_modules/.bin`, so the checked-in example exercises the consumer's path rather than a shortcut.

**The name.** `arch` is taken on npm and, worse, means CPU architecture in Node (`process.arch`). `fitc4` — the underside of an arch — is unregistered. The package stays `private: true` until the name is claimed.

**Config discovery was anchored to the wrong thing, twice.** It started from `import.meta.url`, which resolves inside `node_modules` once installed; it now starts from `process.cwd()`. Then walking *up* from the working directory turned out to find a config nested in a subdirectory only from inside that subdirectory, which is not where anyone stands — discovery now checks `./fitc4.config.json` and `./.fitc4/fitc4.config.json` at each level, root-adjacent winning so a project that hoists its config is never silently overruled by the copy it left behind. `--config` overrides discovery entirely, because a tool that quietly checked a different repository than the one named would report the wrong result confidently.

**The tool owns a config file, not a directory.** `fitc4.config.json` goes at the project root, beside `tsconfig.json`, and `.fitc4/` exists only as a fallback for projects that would rather not add a root-level file. The model is deliberately not in either: `model.c4` is authored architecture documentation with value independent of this tool — reviewable in a pull request, renderable by LikeC4 — and a hidden tool directory is where machine state goes, not where a design contract goes. The `model` setting points wherever the team wants it. The JSON schema ships from the package (`schema/`) rather than being copied into each consumer.

**`dist/` is what ships.** Node strips types natively, so `node src/cli.ts` runs here, but a published package cannot assume its consumers are on Node 26. The sources import each other with `.ts` extensions; `rewriteRelativeImportExtensions` converts them on emit. `build` runs inside `check` so the emit path cannot rot unnoticed.

**The CLI is one caller, not a layer.** `cli.ts` runs the pipeline on import, so the provider composition moved to `preset.ts` and everything the CLI can do is exported from `index.ts`. A host project can run the pipeline inside its own test suite instead of shelling out.

TypeScript 6 and LikeC4 became runtime `dependencies` rather than devDependencies. TypeScript is the awkward one — a consumer already on 7 gets a second copy — but a plain dependency is honest about needing 6 specifically. Revisit at the 7.1 upgrade.

### Still unanswered

Questions 3, 5, and 6 remain open, and will stay near-vacuous until the prototype runs against something larger than a two-component model. The cheapest fix is to make `fitc4` self-hosting: give `packages/fitc4` its own `arch/` directory and scan `packages/fitc4/src`.

## Unchanged from Version 3

The pipeline, `Observation` / `Finding`, the supporting primitives, the provider function types, the native-model decision, and every explicit non-goal. `Association` gains one optional field, recorded above.
