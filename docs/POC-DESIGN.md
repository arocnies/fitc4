# Architecture Control Proof of Concept

Status: draft design for review. This document does not authorize implementation.

## Goal

Build a small TypeScript architecture-control pipeline inside the existing `arch` npm workspace. The pipeline should use native tools for facts they already understand, exchange plain TypeScript/JSON contracts between phases, and optionally let any local command contribute additional observations, associations, or findings.

The proof of concept should demonstrate useful architecture checks without creating an AI-provider framework, plugin system, persistent artifact store, or new project layout.

## Decisions

1. LikeC4 remains the architecture model and owns model parsing and validation.
2. Git and the TypeScript compiler API provide the deterministic implementation facts.
3. Scan, resolve, and validate exchange small versioned TypeScript structures that can be serialized as JSON.
4. An optional **configured command** is any executable that reads JSON from standard input and writes JSON to standard output. The core does not classify it as local AI, remote AI, or a provider.
5. Built-in deterministic behavior runs first. Configured commands may append items to a phase result.
6. No generated results are committed or written to an artifact directory by default.

## Alternatives Considered

### Provider or plugin framework

Define provider interfaces, registries, capabilities, and dedicated AI configuration. This resembles Erode but creates machinery before the proof of concept establishes which extension points are valuable. It is rejected for the initial version.

### File-based phase handoffs

Require every phase to read and write files under `arch/results`. This makes inspection easy but introduces lifecycle, cleanup, and stale-result problems. The proof of concept will pass typed values in process and use JSON only at CLI boundaries.

### Configured JSON commands

Run ordinary commands with JSON on stdin and stdout. This works with a local AI harness, a deterministic executable, or a wrapper around another tool without teaching the architecture code about any of them. This is the selected approach.

## Pipeline

```text
LikeC4 format/validate ──────────────┐
                                    │
Git + TypeScript source             │
          │                         │
          ▼                         │
        scan                        │
          │ ScanResult              │
          ▼                         │
        resolve ◀──── ModelSnapshot─┘
          │ ResolveResult
          ▼
        validate ◀── ModelSnapshot
          │ ValidationResult
          ▼
       report and exit code
```

Each phase has one job:

- **Model validation** checks the LikeC4 contract using LikeC4 itself.
- **Scan** records implementation observations without interpreting the architecture model.
- **Resolve** associates observations with model elements and relationships.
- **Validate** applies architecture rules to the resolved observations.

Facts, associations, and judgments remain separate.

## Reuse Before Custom Code

The proof of concept should prefer the following existing tools:

- `likec4 format --check .` and `likec4 validate .` for model validation.
- The LikeC4 Model API for a normalized model snapshot. Do not parse `.c4` text.
- The `git` CLI for repository files and change status. Do not add a Git library.
- The TypeScript compiler API for parsing and resolving imports. Do not scan TypeScript with regular expressions.
- The repository's existing Vitest installation for tests.
- The repository's current Node runtime for executing erasable TypeScript directly during the proof of concept. A separate TypeScript runner is not needed initially.

Custom LikeC4 model rules are out of scope initially. If they become necessary, use LikeC4's supported custom-validation approach rather than adding those rules to the architecture scanner.

## Contracts

TypeScript types are the canonical in-process contracts. Their JSON representation is the command boundary and diagnostic output. Every serialized contract starts with `contractVersion: 1` so incompatible changes fail clearly.

The shared envelope is intentionally small:

```ts
interface PhaseResult<T> {
  contractVersion: 1;
  items: T[];
}

interface Provenance {
  producer: string;
  confidence?: number;
  detail?: string;
}
```

`producer` identifies the concrete source, such as `git`, `typescript-ast`, or a configured command ID. It does not describe where an AI model runs. `confidence` is optional and is mainly useful for inferred items.

### Model snapshot

The LikeC4 Model API is adapted to only the fields the other phases need:

```ts
interface ModelSnapshot {
  elements: Array<{
    id: string;
    kind: string;
    title: string;
    sourceRoots: string[];
  }>;
  relationships: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    kind: string;
  }>;
}
```

Additional LikeC4 data should not be copied into this structure until a concrete rule needs it.

### Scan result

`ScanResult` contains observations. The built-in scanner initially produces file and static dependency observations. Configured commands may also add component or interface candidates that static analysis cannot discover.

```ts
type ScanItem =
  | FileObservation
  | DependencyObservation
  | ComponentCandidate
  | InterfaceCandidate;

type ScanResult = PhaseResult<ScanItem>;
```

The minimum common fields are an item ID, a `kind`, provenance, and evidence such as a path or source location. Dependency observations name a source path, a target path or external name, and a dependency kind such as `import`, `call`, `message`, or `unknown`.

The proof of concept only discovers `import` dependencies deterministically. The other dependency kinds exist so configured commands can express semantic observations without inventing a parallel format.

### Resolve result

Resolution does not modify scan items. It adds associations that refer to them:

```ts
interface Association {
  id: string;
  scanItemId: string;
  status: "resolved" | "unresolved" | "ambiguous";
  sourceElementId?: string;
  targetElementId?: string;
  relationshipId?: string;
  provenance: Provenance;
}

interface ResolveResult {
  contractVersion: 1;
  scan: ScanResult;
  associations: Association[];
}
```

The deterministic resolver uses LikeC4 `sourceRoot` metadata. For the proof of concept, a source root is a repository-relative directory prefix optionally ending in `/**`, matching the style already used by `model.c4`. General glob semantics are deferred.

### Validation result

Validation produces findings and does not rewrite the model or resolved data:

```ts
interface Finding {
  id: string;
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  relatedIds: string[];
  provenance: Provenance;
}

type ValidationResult = PhaseResult<Finding>;
```

The process exits unsuccessfully when the final result contains an `error`. A configured validation command participates through this same rule: it may return advisory findings or errors, and its configured presence makes that choice explicit.

## Configured Command Interface

Each phase may have zero or more configured commands. The built-in implementation runs first. Commands then run in configuration order, and each sees the items accumulated so far.

The request sent to stdin contains:

```ts
interface ContributionRequest<TContext, TItem> {
  contractVersion: 1;
  phase: "scan" | "resolve" | "validate";
  context: TContext;
  current: TItem[];
}
```

The command returns only additions:

```ts
interface ContributionResponse<TItem> {
  contractVersion: 1;
  items: TItem[];
}
```

This append-only response prevents a command from accidentally dropping deterministic results. Duplicate item IDs, the wrong contract version, malformed JSON, or an invalid item fail the phase with a clear error.

Commands are launched directly with an argument array and without a shell. JSON is written to stdin, stdout is reserved for the response, and stderr is inherited for logs. A nonzero exit code fails the phase. A local AI CLI that cannot directly follow this protocol can use a small external wrapper; adapting every possible CLI is not part of this tool.

The command protocol is the only extension mechanism in the proof of concept. There is no provider SDK, prompt registry, model registry, discovery system, or lifecycle API.

## Configuration

Add one `arch/arch.config.json` file:

```json
{
  "version": 1,
  "repository": "..",
  "model": ".",
  "source": ["../src"],
  "commands": {
    "scan": [],
    "resolve": [],
    "validate": []
  }
}
```

A configured command has only the fields needed to execute it:

```json
{
  "id": "semantic-scan",
  "command": "my-ai-harness",
  "args": ["scan", "--structured-output"]
}
```

Paths are relative to `arch.config.json`. Commands run with the repository root as their working directory and inherit the caller's environment. Removing a command from the array disables it. Environment-variable management, provider keys, prompt templates, retries, and per-command working directories are deferred.

## Built-in Proof-of-Concept Behavior

### Model validation

Keep native LikeC4 commands in the workspace scripts. The architecture pipeline only runs after they succeed. Loading the model through the LikeC4 API also fails if a usable snapshot cannot be produced.

### Scan

The built-in scan:

1. Uses Git to enumerate tracked and untracked, non-ignored source files.
2. Records current Git change status when available.
3. Parses current `.ts` and `.tsx` files under the configured source directories.
4. Records static imports and re-exports.
5. Resolves relative and TypeScript-configured module paths where possible.

The initial scan represents the current implementation graph. Git status scopes and annotates feedback, but the proof of concept does not reconstruct deleted source or compare two complete historical AST graphs.

### Resolve

The built-in resolver:

1. Maps each source file to the LikeC4 element whose `sourceRoot` contains it.
2. Marks zero matches as unresolved and multiple matches as ambiguous.
3. Converts imports between two resolved elements into observed component relationships.
4. Leaves package imports and semantic command observations unresolved unless enough information exists to associate them safely.

Configured commands may add associations for ambiguous or semantic observations. They do not edit the LikeC4 model.

### Validate

The initial deterministic rules are:

- `unmapped-source`: an in-scope source file has no model element.
- `ambiguous-source`: a source file belongs to multiple model elements.
- `missing-relationship`: an observed internal dependency has no matching LikeC4 relationship.
- `relationship-direction`: the model only declares the opposite direction.
- `missing-component`: a component candidate cannot be associated with a model element.
- `unresolved-observation`: a semantically meaningful observation could not be resolved; initially a warning.

The proof of concept does not flag a declared relationship merely because no TypeScript import supports it. LikeC4 relationships may represent runtime calls, data flows, or messaging that a static import scan cannot observe.

## Commands

The workspace should eventually expose:

```text
npm run model:validate -w ./arch   # native LikeC4 validation
npm run scan -w ./arch             # emit ScanResult JSON
npm run resolve -w ./arch          # run through resolve and emit ResolveResult JSON
npm run validate -w ./arch         # run through validate and emit ValidationResult JSON
npm run check -w ./arch            # model validation plus the complete pipeline
npm run view -w ./arch             # existing LikeC4 viewer
```

`resolve` runs scan first, and `validate` runs scan and resolve first. This avoids requiring users to manage intermediate files. The contracts are still serializable for inspection and configured commands.

The existing native LikeC4 `validate` script would be renamed to `model:validate`, leaving `validate` for the complete scan/resolve/validate pipeline through its final phase.

## Expected Code Footprint

Keep the proof of concept within the existing workspace:

```text
arch/
  arch.config.json
  model.c4
  package.json
  src/
    contracts.ts
    pipeline.ts
    cli.ts
```

Tests may sit beside these files or in one small test directory. Phase-specific modules should only be split out if `pipeline.ts` becomes difficult to understand.

## Error Handling

- LikeC4 validation failure stops the pipeline before scanning.
- Git unavailability, unreadable configuration, or invalid source roots are operational errors.
- A TypeScript file that cannot be parsed produces a scan error with its path.
- An unresolved import is an observation, not automatically an operational failure.
- Command failures identify the configured command ID, phase, exit status, and stderr context.
- Command JSON receives minimal runtime validation at the process boundary. The proof of concept uses small handwritten guards rather than adding a schema library.

## Testing

Use the existing Vitest dependency and small temporary fixture repositories. Tests should cover:

1. TypeScript import extraction.
2. `sourceRoot` ownership resolution, including missing and overlapping roots.
3. Declared and undeclared relationship validation.
4. JSON contract serialization.
5. A fixture command that appends one valid item.
6. Rejection of malformed command output and duplicate IDs.
7. One end-to-end check from fixture source and model to findings.

A real AI CLI is not required for automated tests. The fixture command proves the protocol, while users can configure their preferred harness manually.

## Non-goals

- Calling an AI provider API directly.
- Naming or categorizing executors as local or remote AI.
- Managing prompts, models, credentials, retries, or rate limits.
- Automatically modifying `model.c4`.
- Supporting languages other than TypeScript.
- Inferring runtime HTTP, database, or message-bus behavior deterministically.
- Producing a visual base-versus-head LikeC4 diff.
- Persisting phase results, caches, or scan history.
- Reconstructing a complete architecture graph for historical Git revisions.

## Proof-of-Concept Acceptance Criteria

The proof of concept is successful when:

1. `npm run check -w ./arch` first uses native LikeC4 validation and then runs the deterministic architecture pipeline without an API key or network dependency.
2. A TypeScript import crossing two `sourceRoot` boundaries is resolved to the corresponding LikeC4 elements.
3. A declared relationship passes and an undeclared relationship produces a stable validation finding.
4. Missing and overlapping source ownership produce clear findings.
5. A configured local command can append a scan item, association, or finding using the same JSON contracts as the built-in code.
6. The configured command's provenance remains visible in downstream output.
7. With no commands configured, the tool remains a useful deterministic architecture check.
