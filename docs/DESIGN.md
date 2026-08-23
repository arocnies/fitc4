# FitC4 design

The current design of record, written from the code as it stands. The proof-of-concept design history lives in the git history rather than alongside this document.

FitC4 checks an implementation against a LikeC4 architecture model. The model is a user-defined contract: which components exist and which may depend on which. The tool's job is fitting the code to that contract. The LikeC4 model is the *only* architecture-model representation. Providers query the live model API and nothing snapshots elements or relationships, so no copy can drift from `model.c4`.

## The pipeline

```
native LikeC4 validation → scan → resolve → validate → report
```

Native LikeC4 validation gates everything ([`model.ts`](../packages/fitc4/src/model.ts)). An invalid model stops the run before scanning, and an *empty* model is an error too. A deleted `model.c4` must not yield a gate with nothing to gate on.

Each phase has one provider type ([`types.ts`](../packages/fitc4/src/types.ts)):

| Phase | Type | Receives | Returns |
|---|---|---|---|
| scan | `ScanProvider` | `repositoryRoot` | `Observation[]`, implementation facts |
| resolve | `ResolveProvider` | model, observations, `repositoryRoot` | `Association[]`, mappings onto the model |
| validate | `ValidateProvider` | model, observations, associations, `repositoryRoot` | `Finding[]`, judgments with a severity |

A scanner observes the repository and knows nothing about the model; a resolver maps facts onto the model without judging; a validator judges without gathering. Providers are plain async functions composed into phase arrays, with no registry, lifecycle, or discovery system. The core ([`pipeline.ts`](../packages/fitc4/src/pipeline.ts)) sequences the phases, namespaces every emitted id with the provider's composed id, checks `data` for JSON-round-trip safety, and contains failures. A provider that throws becomes one `provider-failure` error finding, and the other providers still run.

The default composition ([`defaults.ts`](../packages/fitc4/src/defaults.ts)) is `typescript-imports` → `source-root` → `architecture-rules`. Every report names the providers that composed each phase, so a replaced phase is visible in the output, not only in the config.

## The envelope

`Observation`, `Association`, and `Finding` are the three pipeline objects. Anything every provider must rely on lives in their named fields: `kind`, `subject`, `target`, `evidence`, `candidates`, `severity`. It never lives in `data`. The core never interprets `data`; providers may read each other's, but the reader owns the coupling.

`Observation.kind` and `Ref.kind` are the one contract that crosses provider boundaries, named in [`kinds.ts`](../packages/fitc4/src/kinds.ts). Standard observation kinds: `file`, `dependency`, `unresolved-dependency`, and `scan-root`, the coverage attestation that records what the provider actually looked at. Standard ref kinds: `element`, `relationship` (the model); `file`, `directory`, `module`, `symbol` (the repository); `observation`, `provider` (the pipeline). `symbol` is reserved and nothing emits it. The vocabulary is open. A provider may emit private kinds, and two providers that understand each other may cooperate. What the standard set buys is a default that works. A kind the standard rules do not read is reported (`unknown-observation-kind`, info), never silently dropped.

Identifiers come from author-controlled names: element FQNs, `source::kind::target` for relationships, `provider/rule/subject` for findings. Never from LikeC4's generated relationship hashes, which are unstable across runs.

## Never fail open

The property the whole tool exists for: a check that silently reports nothing is worse than no check, because it looks like success. Most of the rule set exists because this was violated once. The concrete mechanisms:

- **Coverage attestations.** Scanners emit a `scan-root` observation per root actually walked, and refuse to run with no roots, a missing root, or a root holding no code. Rules judge ownership only where the scan looked. The agent scanner's required `examined[]` is the same attestation. An empty one is a failure, because a scan that read nothing must not read as a clean domain.
- **Metadata that matches nothing is an error.** `invalid-sources` / `unmatched-sources` for ownership, `invalid-packages` / `ambiguous-package` / `unmatched-packages` for package claims. A typo'd prefix once turned three architecture errors into a clean exit 0.
- **Staged provider output.** A provider's items are staged and committed as a unit; one that fails partway (including on a duplicate id) contributes nothing. Half a result is a misleading one.
- **Unknown kinds are reported.** A scanner emitting `import` where the rules read `dependency` would otherwise produce zero findings and exit 0, indistinguishable from a clean repository.
- **Structural containment.** `orphaned-association` (an association referencing a nonexistent observation), forced-`error` for unrecognized severities, and the JSON-safety walk that rejects what `JSON.stringify` would silently discard.
- **Agent schema enforcement and escalation.** An agent reply that parses but does not match the requested schema is a failure, not a value. Advisory providers degrade to a visible `agent-unavailable` finding; a provider promoted to `severity: 'error'` escalates `agent-unavailable` and `agent-truncated` to errors. A gate whose judge is absent must not pass. The fail-closed scan/resolve providers throw outright (below).

The gate itself is one function: exit 1 when any finding has severity `error`. Severities are per-rule defaults with per-rule overrides (`architectureRules({ severity: {...} })`). Promoting or softening a rule is policy, chosen in the config that owns it.

## Ownership and rules

`sources` metadata maps repository paths onto elements: repository-relative directory prefixes, optionally ending in `/**`, longest match wins, a tie is `ambiguous-source`. General globs are deliberately unimplemented. FitC4 rejects anything the prefix matcher cannot honour (`invalid-sources`) rather than silently matching nothing. An unowned *file* is a finding (`unmapped-source`); an unowned *element* is not.

**Fragment claims** extend ownership below the file. A `sources` entry containing `#` claims a region inside one file, `<file path>#<fragment>`, for domains where several elements live in a single file: a compose file declaring every service of a stack, a workflow definition. The fragment is an opaque dot-delimited locator; a scan provider emits subjects of the same form (`docker/docker-compose.yml#services.auth`), and the agent scanner accepts them on `file` refs, guarding the path part against hallucination exactly as it guards a plain path. Resolution is the same longest-claim rule as directories, with the fragment's dots playing the trailing slash's role, so `#services.auth` never claims `#services.auth2`, and an unclaimed fragment falls back to whichever element owns the file. Fragment claims stay fail-closed: one that no observation touches, inside a file the scan attested to examining, is `unmatched-sources`. Without this mechanism a single-file domain collapses into blanket ownership, where every wrong edge resolves inside one element's boundary and mistakes are consequence-free.

Relationships are judged with containment semantics. A relationship declared between two parents covers traffic between their descendants, and an element never crosses a boundary into its own ancestor or descendant. LikeC4 refuses to declare parent-child relationships, so reporting those would leave no fix. Kind is ignored when matching, because an observed import carries no LikeC4 relationship kind. Undeclared crossings are `missing-relationship`; a crossing whose reverse is declared is `relationship-direction`, a stronger signal.

The full rule set and standard severities live in the READMEs' rules tables; `ArchitectureRuleId` in [`architecture-rules.ts`](../packages/fitc4/src/providers/architecture-rules.ts) is the authoritative list.

## Tolerated drift

Brownfield adoption needs a way to say "this dependency exists, we know, stop shouting, but do not let it grow." FitC4's answer is model-native: tag the relationship in the model.

- The tag defaults to `drift` (`architectureRules({ driftTag })` configures it) and must be declared in the LikeC4 specification (`tag drift`), because LikeC4 rejects unknown tags.
- A drift-tagged relationship is an ordinary declared relationship, so the dependencies it covers stay legal. The `DriftLedger` counts resolved crossings against every drift edge covering them; coverage is tested per edge, so a dependency also covered by an untagged relationship still counts as exercising the drift edge.
- Every drift edge yields exactly one finding per run. Code still exercising the edge produces `drift-relationship` (info), and that is the burn-down. Nothing exercising it produces `unused-drift` (warning), whose fix is deleting the relationship. A drift edge the code no longer exercises must be deleted, so declared drift can only shrink. The granularity is the edge, not the import volume. One finding stands whether one dependency rides the edge or forty, so what can only shrink is the set of tolerated edges.
- The report derives a burn-down line from the findings alone, `drift: N declared, M exercised, K unused`, so a `--json` consumer computes identical numbers.
- Promotions tune the policy: `drift-relationship: 'error'` forbids all tolerated drift; `unused-drift: 'error'` fails the build until the dead edge is deleted.

**Why no state file.** Baseline-file tools (`--update-baseline`, snapshot suppression files) keep the debt in generated machine state: invisible in the diagram, regenerated wholesale, rubber-stamped in review. Here the debt *is* model text. A tagged relationship has a name and a diagram edge, and it is added and deleted in reviewable diffs. The counts are recomputed from code every run, so there is nothing to regenerate and nothing that can drift from the model.

## Package claims

`packages` element metadata claims external npm packages, the same shape as `sources` (string or array, plain LikeC4 metadata). A value is an exact package name, `pg` or `@aws-sdk/client-s3`, never a subpath. Imports of any subpath map onto the claim via `packageNameOf`.

Resolution ([`source-root.ts`](../packages/fitc4/src/providers/source-root.ts)) maps a `dependency` observation with a `module` target onto the claiming element, after which the association is indistinguishable from a file-to-file crossing. The standard relationship rules judge it with no package-specific rule code. That is what buys "only infra may import `pg`": claim the package on the infra element, and every import from elsewhere is a `missing-relationship` unless declared. Unclaimed packages stay unrestricted, and the fail-closed family (`invalid-packages`, `ambiguous-package`, `unmatched-packages`) keeps a typo'd claim from silently gating nothing. An unresolvable specifier is never claim-resolved. That would bless a broken import as a checked edge.

## Unobserved elements

An element with neither `sources` nor `packages` is legal. It may be an external system, a person, or a pure-thought abstraction. But it is silently unenforced, indistinguishable from a typo'd claim key. One `unobserved-elements` info finding per run lists the leaf elements in that state, so deliberate abstraction stays legal but visible, and chosen rather than accidental. Parents whose children carry claims are structural, not unobserved; only leaves count.

## Drafting

`fitc4 draft` ([`draft.ts`](../packages/fitc4/src/draft.ts)) bootstraps a first model on a brownfield repository: it runs the configured scan providers with no model loaded and renders their observations as a starting point the human rewrites, never a sync. The governing principle: the draft mirrors the structure the observations report, not the filesystem hierarchy. Three consequences:

- **Structural splitting.** Each scan root splits into its first-level directories; below that, a directory splits into nested child elements only where an observed dependency crosses between two of its subdirectories, and collapses into a single element where none does, however deep its folders go. Granularity comes from the code's own dependency graph, with no depth knob to configure. A split directory holding files of its own keeps a `<dir>/**` claim, and longest-prefix ownership hands each subdirectory to its child element, so the parent ends up owning exactly its direct files; a split directory without direct files is a pure container with no claim.
- **Fragment elements.** A `file` observation whose subject carries a fragment locator becomes its own element, nested under an element for the containing file and claiming the locator verbatim. No option gates this: emitting fragments is already opt-in at the scan instructions, so their presence in the observations is the request.
- **Boundary elements.** A dependency target of a kind that is not a repository path or an npm package (a `system`, a `service`) becomes a description-only element beside the vendor stub, one per distinct kind and id.

Elements derive from `file` observations and never from listing the filesystem, so every emitted claim matches something observed. Edges resolve through the same longest-claim ownership the gate uses and connect the deepest owning elements. Every relationship the gate can observe is tagged as tolerated drift, so the drafted model gates green by construction with the debt as the burn-down; the edges to boundary elements are the one exception, emitted plain because the gate resolves nothing onto a description-only element and a drift tag there would be born `unused-drift`.

## Agent provider tiers

`fitc4/agent` is a separate entry point the core never imports; composing an agent provider into a phase is an explicit act in a config file. The exec layer shells out to locally installed agent CLIs (`claude`, `codex`), on the user's own login and billing, with no API keys. Replies are schema-enforced JSON, and `cached()` replays them keyed on everything the model saw.

Two tiers, distinguished by what absence looks like:

- **Advisory validate providers** (`agentOwnershipAdvisor`, `agentSemanticReview`): enrichment. Every deterministic finding stands without them, so an unavailable CLI degrades to a visible `agent-unavailable` finding. `severity: 'error'` opts one into the gate, which escalates its failure modes with it.
- **Fail-closed scan/resolve providers** (`agentScan`, `agentResolve`): load-bearing. An absent scanner looks like a clean scan, and a silently failing resolver produces fewer checks. That is the exact fail-open the project exists to prevent, so any exec failure, off-schema reply, hallucinated path or id, or empty `examined` attestation **throws**, becoming one `provider-failure` error. `agentScan` observes model domains no parser covers, working from prose instructions over a deterministic prefilled file listing. With `focus` it works over embedded excerpts of the matched files instead, a one-shot call whose contents are in the cache key. `agentResolve` maps leftover observations (external packages, unresolvable specifiers) onto elements, including description-only ones. It collapses import sites into per-(element, package) decisions that fan back out to per-site associations. Abstention is legal, hallucination is failure. Per-provider detail: [`agent-providers.md`](agent-providers.md).

Providers prefill from a shared context-pack layer (`src/agent/context-pack.ts`). The pack is a per-run graph of what the pipeline already knows (file adjacency, ownership, package claims, element facts), rendered into neighborhood lines, element facts, and code-first excerpts. A byte budget bounds it, and every drop is announced inline, plus attested as `agent-truncated` in the validate providers. Every pack opens with a `context-pack v1` header so the format's semantics live in the `cached()` key.

The intended lifecycle: **agents prototype, determinism graduates.** A new model domain starts as prose instructions to `agentScan`, and the deterministic rules judge whatever comes back. Once the domain stabilizes, a small deterministic provider replaces the prose. Same envelope, same kinds, same downstream phases, and the report's provider line shows the swap.

## Companion packages

Providers that carry runtime dependencies ship as separate npm packages so `fitc4` core keeps zero of them beyond TypeScript and LikeC4. [`fitc4-dependency-cruiser`](../packages/fitc4-dependency-cruiser) is the first: dependency-cruiser's `cruise()` as a scan provider for JavaScript and mixed projects, declaring `fitc4` as a peer dependency. Consumers install both and compose in config. `NamedProvider<ScanProvider>`, the kind vocabulary, and the fail-closed conventions are the whole integration contract.

## Configuration

One form, one shape ([`config.ts`](../packages/fitc4/src/config.ts)). The config is an ES module (`.ts`, `.mts`, `.js`, `.mjs`, wrapped in `defineConfig`) naming the repository facts (`repositoryRoot`, `model`) and three required provider arrays: `scan`, `resolve`, `validate`. There are no default phases and no merge semantics. What runs is exactly what the file names, so reading the config answers "which providers judge this repository" without consulting anything else. A missing or empty phase is an error that carries the standard composition ready to paste, which keeps the required arrays from being a setup burden: `init` scaffolds them, and the error message reconstructs them.

Discovery starts at the working directory and checks the module names. It looks in the directory itself, then under `.fitc4/`, and repeats up each ancestor. Root-adjacent wins over `.fitc4/`. Two configs in one directory is an error, because whichever lost a silent tiebreak would be a silently ignored config. `--config` overrides discovery entirely. Every path resolves relative to the config file, so moving the workspace cannot silently repoint the scan. Validation is strict: unknown version, unknown fields, blank paths, and malformed phases are errors, never silent defaults.

## Progress narration

Two layers, both just a string callback. `runPipeline` and `draft` accept an optional `onProgress?: (message: string) => void` and call it at the pipeline's natural seams: model load, each phase start, each provider start, each provider done with a count and elapsed time. The library never touches a console. The CLI wires the callback to stderr on every run, and `--quiet` disconnects it. Stderr because stdout is the contract: the report and `--json` output stay byte-identical whether narration is on, off, or piped away.

The second layer is a provider hook. Every provider context carries an optional `progress?: (message: string) => void`, injected by the pipeline and prefixed with the provider's composed id, so a provider reports `scanned 500 of 1200 files` and never names itself. Providers that ignore it lose nothing. Two use it today: `typescript-imports` reports every 500 files, only on repositories large enough to look hung, and `agentScan` announces each agent call before it starts, since that call is the slow step a user is otherwise left staring at.

A plain string because anything richer is a schema. Percentages, progress objects, and structured events each put a contract between the pipeline and whoever renders it, and the first consumer is a human reading stderr.

## Deliberately not built

- **Baseline files.** Tolerated drift lives in the model as reviewable, taggable relationships; a generated suppression file is invisible debt that gets regenerated and rubber-stamped.
- **JSON or YAML config.** Providers are functions, and functions cannot live in data files; a data syntax would need default phases and merge semantics, which is exactly the hidden behavior the explicit config removed.
- **MCP server.** LikeC4 already ships one for querying and authoring the model; FitC4 is the enforcement half, and its agent interface is the CLI report and `--json`.
- **A provider registry or plugin discovery.** Composition is explicit arrays in a config file the user owns; anything cleverer hides which providers judge the run.
- **General glob matching for `sources`.** Directory prefixes have survived real use; a glob engine multiplies the silent mismatches the `invalid-sources`/`unmatched-sources` pair exists to close.
- **Structured progress.** No percentages, progress objects, spinners, or event types; narration is one plain line per seam, and the result object is where structure lives.
