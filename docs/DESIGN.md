# FitC4 design

The current design of record, written from the code as it stands. The path here is preserved in [`history/`](history), including the decisions this document quietly reverses. [`history/POC-DESIGN-v4.md`](history/POC-DESIGN-v4.md) was the last proof-of-concept snapshot.

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

Relationships are judged with containment semantics. A relationship declared between two parents covers traffic between their descendants, and an element never crosses a boundary into its own ancestor or descendant. LikeC4 refuses to declare parent-child relationships, so reporting those would leave no fix. Kind is ignored when matching, because an observed import carries no LikeC4 relationship kind. Undeclared crossings are `missing-relationship`; a crossing whose reverse is declared is `relationship-direction`, a stronger signal.

The full rule set and standard severities live in the READMEs' rules tables; `ArchitectureRuleId` in [`architecture-rules.ts`](../packages/fitc4/src/providers/architecture-rules.ts) is the authoritative list.

## Tolerated drift

Brownfield adoption needs a way to say "this dependency exists, we know, stop shouting, but do not let it grow." FitC4's answer is model-native: tag the relationship in the model.

- The tag defaults to `drift` (`architectureRules({ driftTag })` configures it) and must be declared in the LikeC4 specification (`tag drift`), because LikeC4 rejects unknown tags.
- A drift-tagged relationship is an ordinary declared relationship, so the dependencies it covers stay legal. The `DriftLedger` counts resolved crossings against every drift edge covering them; coverage is tested per edge, so a dependency also covered by an untagged relationship still counts as exercising the drift edge.
- Every drift edge yields exactly one finding per run. Code still exercising the edge produces `drift-relationship` (info), and that is the burn-down. Nothing exercising it produces `unused-drift` (warning), whose fix is deleting the relationship. A drift edge the code no longer exercises must be deleted, so declared drift can only shrink.
- The report derives a burn-down line from the findings alone, `drift: N declared · M exercised · K unused`, so a `--json` consumer computes identical numbers.
- Promotions tune the policy: `drift-relationship: 'error'` forbids all tolerated drift; `unused-drift: 'error'` fails the build until the dead edge is deleted.

**Why no state file.** Baseline-file tools (`--update-baseline`, snapshot suppression files) keep the debt in generated machine state: invisible in the diagram, regenerated wholesale, rubber-stamped in review. Here the debt *is* model text. A tagged relationship has a name and a diagram edge, and it is added and deleted in reviewable diffs. The counts are recomputed from code every run, so there is nothing to regenerate and nothing that can drift from the model.

## Package claims

`packages` element metadata claims external npm packages, the same shape as `sources` (string or array, plain LikeC4 metadata). A value is an exact package name, `pg` or `@aws-sdk/client-s3`, never a subpath. Imports of any subpath map onto the claim via `packageNameOf`.

Resolution ([`source-root.ts`](../packages/fitc4/src/providers/source-root.ts)) maps a `dependency` observation with a `module` target onto the claiming element, after which the association is indistinguishable from a file-to-file crossing. The standard relationship rules judge it with no package-specific rule code. That is what buys "only infra may import `pg`": claim the package on the infra element, and every import from elsewhere is a `missing-relationship` unless declared. Unclaimed packages stay unrestricted, and the fail-closed family (`invalid-packages`, `ambiguous-package`, `unmatched-packages`) keeps a typo'd claim from silently gating nothing. An unresolvable specifier is never claim-resolved. That would bless a broken import as a checked edge.

## Unobserved elements

An element with neither `sources` nor `packages` is legal. It may be an external system, a person, or a pure-thought abstraction. But it is silently unenforced, indistinguishable from a typo'd claim key. One `unobserved-elements` info finding per run lists the leaf elements in that state, so deliberate abstraction stays legal but visible, and chosen rather than accidental. Parents whose children carry claims are structural, not unobserved; only leaves count.

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

Three forms, one shape ([`config.ts`](../packages/fitc4/src/config.ts)). `fitc4.config.json` holds what differs between repositories (`repositoryRoot`, `model`, `scanRoots`, `tsconfig`), and a shipped JSON schema validates it. The module forms (`.ts`, `.mts`, `.js`, `.mjs`, wrapped in `defineConfig`) carry the same fields plus optional `scan`/`resolve`/`validate` provider arrays, because functions cannot live in JSON. A phase array that is present replaces the defaults for that phase entirely; extending means spreading `defaultResolve`/`defaultValidate` back in. Merge semantics belong to the user, in the file they can see.

Discovery starts at the working directory and checks the module names, then the JSON name. It looks in the directory itself, then under `.fitc4/`, and repeats up each ancestor. Root-adjacent wins over `.fitc4/`. Two configs in one directory is an error, because whichever lost a silent tiebreak would be a silently ignored config. `--config` overrides discovery entirely. Every path resolves relative to the config file, so moving the workspace cannot silently repoint the scan. Validation is strict: unknown version, empty `scanRoots`, blank paths, and malformed JSON are errors, never silent defaults.

## Deliberately not built

- **Baseline files.** Tolerated drift lives in the model as reviewable, taggable relationships; a generated suppression file is invisible debt that gets regenerated and rubber-stamped.
- **YAML config.** JSON has the schema and the module forms have the functions; a third syntax adds another parser without adding expressiveness.
- **MCP server.** LikeC4 already ships one for querying and authoring the model; FitC4 is the enforcement half, and its agent interface is the CLI report and `--json`.
- **A provider registry or plugin discovery.** Composition is explicit arrays in a config file the user owns; anything cleverer hides which providers judge the run.
- **General glob matching for `sources`.** Directory prefixes have survived real use; a glob engine multiplies the silent mismatches the `invalid-sources`/`unmatched-sources` pair exists to close.
