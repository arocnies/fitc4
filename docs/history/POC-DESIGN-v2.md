> **Historical design document**, superseded by [../DESIGN.md](../DESIGN.md); kept as the record of how the design evolved.

# Architecture Control Proof of Concept — Version 2

Status: draft amendment for review. This file is untracked and does not authorize implementation.

This version preserves [`POC-DESIGN.md`](./POC-DESIGN.md) as the previous design snapshot. It supersedes that document where the two versions differ. The main refinement is that providers may use rich internal analysis, but the `arch` workspace only exchanges small architecture-level projections.

## Version History

| Version | Scope |
|---|---|
| 1 | Four-phase pipeline, JSON command boundary, LikeC4-native model validation, TypeScript/Git scan, and basic contracts |
| 2 | Provider use across phases, compact architecture-level observations, extensible validation findings, and a concrete POC provider matrix |

## Scope Lock

The proof of concept is not a general code intelligence platform. It does not reproduce Code-Graph-RAG, a compiler AST graph, a graph database, or a RAG system.

The core knows only three kinds of implementation result:

```text
Observation  →  Association  →  Finding
```

Provider tools may build richer graphs internally. They must project those graphs into these small phase contracts before data enters `arch`.

## Provider Model

A provider is a phase-specific implementation that contributes one of the standard result types:

- a scan provider contributes observations;
- a resolve provider contributes associations;
- a validation provider contributes findings.

The same underlying tool may be configured for more than one phase, but each phase has a separate adapter and contract. There is no universal provider result union and no capability registry.

The built-in deterministic providers run first. Configured command providers run afterward in configuration order and may append results. A command reads a phase request as JSON from stdin and returns JSON additions on stdout.

Code-Graph-RAG is a possible provider at several phases. Its internal `Module`, `Function`, `CALLS`, `FLOWS_TO`, and resource graph remains provider-owned. The adapter should return only the boundary observations, model associations, or architecture-scoped findings needed by the current phase.

## Small Contracts

The existing version-1 envelope remains the basis:

```ts
interface PhaseResult<T> {
  contractVersion: 1;
  items: T[];
}
```

### Observation

An observation is a compact implementation fact. The initial kinds are:

```ts
type ObservationKind =
  | "file"
  | "dependency"
  | "component-candidate"
  | "interface-candidate";
```

Every observation has a stable ID, a kind, a producer, and only the evidence needed to resolve it. Source snippets, full AST nodes, function inventories, and complete provider graphs do not cross the boundary.

An observation may include:

```ts
interface EvidenceRef {
  path?: string;
  line?: number;
  detail?: string;
}
```

`detail` is optional and short. It is not a source-code payload.

### Association

An association connects an observation to LikeC4 elements:

```ts
interface Association {
  id: string;
  observationId: string;
  status: "resolved" | "unresolved" | "ambiguous";
  sourceElementId?: string;
  targetElementId?: string;
  relationshipId?: string;
  producer: string;
}
```

### Finding

All validation providers return the same finding shape:

```ts
interface ModelRef {
  kind: "file" | "component" | "relationship" | "observation";
  id: string;
}

interface Finding {
  id: string;
  ruleId: string;
  severity: "error" | "warning" | "info";
  subject: ModelRef;
  related?: ModelRef[];
  evidence?: EvidenceRef[];
  message?: string;
  producer: string;
  confidence?: number;
}
```

The result is intentionally reference-heavy and prose-light. Renderers can derive standard text from `ruleId`, while providers may supply a short `message` when it improves clarity.

Finding IDs should be stable across repeated runs. A provider/rule/subject combination is sufficient for the POC; a separate deduplication or fingerprinting system is not needed.

## Validation Aggregation

`arch validate` runs all enabled validation providers and merges their `Finding[]` results. It preserves producer identity and does not rewrite provider messages.

Configured command providers have a small execution mode:

```json
{
  "id": "semantic-validation",
  "command": "./tools/semantic-check",
  "args": [],
  "mode": "advisory"
}
```

The modes are:

- `advisory`: findings are reported but cannot fail the process;
- `blocking`: `error` findings can fail the process.

Built-in architecture rules are blocking by default. Configured commands are advisory by default and must opt into blocking behavior. This allows semantic tools and AI commands to provide useful hints without silently becoming the authority for deterministic enforcement.

Providers must express findings in terms of model elements, relationships, ownership, or observations. A raw code smell, dead function, or generic style issue is not an `arch validate` finding unless it has an architecture-level subject.

## Basic POC Provider Matrix

The POC should demonstrate the provider mechanism with the smallest useful set.

### Core providers — implement first

| ID | Phase | Role | Nature |
|---|---|---|---|
| `likec4-model` | model validation | Run native LikeC4 format and validation commands; load the model snapshot through the LikeC4 API | Existing tooling |
| `typescript-imports` | scan | Enumerate source files and extract static imports/re-exports with the TypeScript compiler API | Deterministic |
| `source-root` | resolve | Map source paths to LikeC4 elements using existing `sourceRoot` metadata | Deterministic |
| `architecture-rules` | validate | Check ownership, observed internal dependencies, declared relationships, and relationship direction | Deterministic |

These providers should be useful with no configured commands and no network or AI dependency.

### Extension demonstrations — implement as fixtures

| ID | Phase | Role | Demonstrates |
|---|---|---|---|
| `mock-semantic-scan` | scan | Append an `interface-candidate` or semantic `dependency` that the AST scanner does not emit | Scan augmentation |
| `mock-semantic-resolve` | resolve | Resolve the mock observation to a LikeC4 component or return an ambiguous association | Resolve augmentation |
| `mock-semantic-validation` | validate | Return one advisory finding tied to a component or relationship | Validation extension and provenance |
| `mock-blocking-validation` | validate | Return one deterministic blocking error | Provider gating mode |
| `mock-invalid-command` | any | Emit malformed JSON, duplicate IDs, or a nonzero exit code | Boundary error handling |

The mock commands should be tiny fixture executables. They should not simulate a full language model; their purpose is to prove that the phase contract and aggregator work.

### Deferred provider — design for, do not require

| ID | Phase(s) | Role |
|---|---|---|
| `code-graph-rag` | scan, resolve, or validate | Adapt a Code-Graph-RAG query/export into compact observations, associations, or findings |

The POC may use a fixture whose output is shaped like a Code-Graph-RAG projection. Installing Memgraph, Qdrant, Tree-sitter language packs, or a local model is not part of the POC acceptance criteria.

## Provider Inputs

Providers should receive only the context needed for their phase:

| Phase | Minimum context |
|---|---|
| Scan | Repository root, source roots, Git change status, and current source paths |
| Resolve | `ScanResult` plus a compact `ModelSnapshot` |
| Validate | `ResolveResult`, compact `ModelSnapshot`, and relevant changed paths |

The pipeline should not send the complete repository or a complete code graph to every command. If a provider needs source details, it can inspect the repository itself using the paths in the request. The core remains responsible for keeping the structured result small.

## POC Flow

```text
native LikeC4 model validation
            │
            ▼
typescript-imports + mock-semantic-scan
            │ ScanResult
            ▼
source-root + mock-semantic-resolve
            │ ResolveResult
            ▼
architecture-rules
            + mock-semantic-validation
            + mock-blocking-validation
            │ ValidationResult
            ▼
stable report and gate result
```

The POC is successful when the same pipeline works with all mock commands removed, with advisory commands enabled, and with a blocking command explicitly enabled.

## Explicit Non-goals for Version 2

- Do not add a generic AST graph to `arch`.
- Do not persist provider graphs or phase artifacts.
- Do not make Code-Graph-RAG a required dependency.
- Do not pass full Code-Graph-RAG exports through phase contracts.
- Do not create a natural-language query layer in the core.
- Do not accept generic code-quality findings into `arch validate`.
- Do not add provider discovery, registries, SDKs, retries, or prompt management.
- Do not add a separate RAG phase.

## Version 2 Acceptance Criteria

1. The deterministic four-phase path works with no configured commands.
2. A scan command can append a compact observation.
3. A resolve command can append an association referencing that observation.
4. Multiple validation commands can append findings to one result.
5. Findings retain stable IDs, rule IDs, producers, references, and evidence.
6. Advisory findings are visible but do not fail the check.
7. Blocking findings fail the check only when explicitly enabled.
8. Malformed command output fails clearly at the JSON boundary.
9. No phase contract contains a full AST, provider graph, source dump, or long natural-language context.

