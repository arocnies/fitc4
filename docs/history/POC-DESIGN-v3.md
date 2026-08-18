> **Historical design document**, superseded by [../DESIGN.md](../DESIGN.md); kept as the record of how the design evolved.

# Architecture Control Proof of Concept — Version 3

Status: draft snapshot for fresh context review. This file is untracked and does not authorize implementation.

This version preserves [`POC-DESIGN.md`](./POC-DESIGN.md) and [`POC-DESIGN-v2.md`](./POC-DESIGN-v2.md) as design history. It supersedes both where they differ.

## Version History

| Version | Main decision |
|---|---|
| 1 | Four phases, native LikeC4 validation, TypeScript/Git scanning, and JSON command boundaries |
| 2 | Compact architecture-level provider projections and validation-provider aggregation |
| 3 | Native LikeC4 model as the only model object, simple TypeScript provider functions, and opaque provider data |

## Goal and Scope

Build a small TypeScript architecture-control pipeline in the existing `arch` workspace. It should compare implementation evidence with a LikeC4 architecture contract and let optional providers add observations, associations, or findings.

The proof of concept is not a code-intelligence platform. It does not reproduce Code-Graph-RAG, maintain a complete AST graph, or introduce a graph database, vector store, or RAG layer.

The core operates at the level of the LikeC4 model:

```text
implementation providers → architecture-level results → LikeC4-aware validation
```

Provider tools may perform richer analysis internally, but they must project their output into the small objects defined here before it enters the pipeline.

## Native Model Decision

LikeC4 remains the only architecture-model representation.

- `likec4 format --check .` and `likec4 validate .` perform native model validation.
- Providers receive the parsed/computed LikeC4 model through the LikeC4 Model API.
- The POC does not define a custom `ModelSnapshot` or duplicate LikeC4 elements and relationships.
- A future out-of-process command may receive a model path or a provider-specific serialized view, but that adapter detail is not a core domain object.

This keeps `model.c4` authoritative and avoids building a second model that can drift from LikeC4.

## Pipeline

```text
native LikeC4 validation
          │
          ▼
scan providers → Observation[]
          │
          ▼
resolve providers → Association[]
          │
          ▼
validate providers → Finding[]
          │
          ▼
report and gate
```

Each phase has one responsibility:

- **Model validation**: LikeC4 validates the model itself.
- **Scan**: providers observe implementation facts.
- **Resolve**: providers associate observations with LikeC4 elements or relationships.
- **Validate**: providers report architecture-level rules, measurements, warnings, or hints.

## Minimal Domain Objects

There are only three pipeline result objects.

### Observation

An observation is a compact implementation fact.

```ts
interface Observation {
  id: string;
  kind: string;
  description?: string;
  subject?: Ref;
  target?: Ref;
  evidence?: Evidence[];
  data?: JsonObject;
  provider: string;
}
```

Initial built-in kinds are `file`, `dependency`, `component-candidate`, and `interface-candidate`. A provider may use another kind without requiring a core schema change; downstream phases should only interpret kinds they understand.

### Association

An association maps an observation to the native LikeC4 model.

```ts
interface Association {
  id: string;
  observationId: string;
  status: "resolved" | "unresolved" | "ambiguous";
  source?: Ref;
  target?: Ref;
  relationship?: Ref;
  description?: string;
  data?: JsonObject;
  provider: string;
}
```

### Finding

A finding is the common output of every validation provider.

```ts
interface Finding {
  id: string;
  ruleId: string;
  severity: "error" | "warning" | "info";
  description: string;
  subject?: Ref;
  related?: Ref[];
  evidence?: Evidence[];
  data?: JsonObject;
  provider: string;
}
```

The standard fields stay short and consistent. `data` is an opaque, JSON-safe object owned by the provider. It can contain measurements, classifications, suggested details, or other structured output without forcing every provider into a global schema.

For example, a stability provider can return:

```json
{
  "ruleId": "stability/metric",
  "severity": "info",
  "description": "Component stability metrics.",
  "subject": { "kind": "component", "id": "project.core" },
  "data": { "ca": 2, "ce": 1, "instability": 0.333 },
  "provider": "stability"
}
```

The core validates only the common envelope and JSON serializability. A provider owns the interpretation of its `data` payload.

### Supporting primitives

```ts
interface Ref {
  kind: string;
  id: string;
}

interface Evidence {
  path?: string;
  line?: number;
  detail?: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
```

Evidence is reference-oriented. Providers do not send full source snippets or complete graph payloads through the core.

## TypeScript Provider Extension Points

The primary extension point is ordinary TypeScript functions composed into phase-specific arrays:

```ts
type ScanProvider = (context: ScanContext) => Promise<Observation[]>;
type ResolveProvider = (context: ResolveContext) => Promise<Association[]>;
type ValidateProvider = (context: ValidateContext) => Promise<Finding[]>;
```

The contexts are execution inputs, not persistent domain objects:

```ts
interface ScanContext {
  repositoryRoot: string;
  sourceRoots: string[];
  changedPaths: string[];
}

interface ResolveContext {
  model: LikeC4Model;
  observations: Observation[];
}

interface ValidateContext {
  model: LikeC4Model;
  observations: Observation[];
  associations: Association[];
}
```

`LikeC4Model` represents the actual native type returned by the installed LikeC4 API; it is an alias in this design document, not a new wrapper type.

There is no provider registry, class lifecycle, capability negotiation, or discovery system in the POC. A provider is imported and placed in the appropriate array.

An external command can be supported later by a thin adapter that implements one of these function types. The command protocol is an execution mechanism, not a second domain model.

## Validation Provider Aggregation

`arch validate` runs all enabled validation providers and concatenates their `Finding[]` results.

Providers can return:

- informational measurements;
- warnings;
- advisory semantic hints;
- blocking architecture violations.

The initial gate policy is:

- built-in deterministic providers may block on `error` findings;
- external command providers are advisory by default;
- a command must explicitly opt into blocking behavior.

Providers must express findings in terms of model elements, relationships, ownership, observations, or other architecture-level references. Generic code smells remain outside `arch validate` unless they can be tied to the architecture contract.

## Basic POC Providers

### Core deterministic providers

| ID | Phase | Role |
|---|---|---|
| `likec4-model` | model validation | Run native LikeC4 formatting/validation and expose the parsed model to providers |
| `typescript-imports` | scan | Enumerate source files and static imports/re-exports with the TypeScript compiler API |
| `source-root` | resolve | Associate source paths with LikeC4 elements using `sourceRoot` metadata |
| `architecture-rules` | validate | Report unmapped ownership, undeclared dependencies, and relationship-direction issues |

The pipeline must remain useful with only these providers enabled.

### Fixture providers for extension testing

| ID | Phase | Demonstrates |
|---|---|---|
| `mock-semantic-scan` | scan | Adds an interface or dependency not emitted by static imports |
| `mock-semantic-resolve` | resolve | Resolves or ambiguously maps a mock observation |
| `mock-semantic-validation` | validate | Adds an advisory architecture-level finding |
| `mock-blocking-validation` | validate | Adds a deterministic blocking error |
| `mock-invalid-provider` | any | Exercises malformed output, duplicate IDs, and provider failure handling |

These are tiny TypeScript fixtures, not simulated language models.

### Deferred Code-Graph-RAG adapter

Code-Graph-RAG may later provide one or more phase adapters:

- scan: project a rich code graph into boundary observations;
- resolve: use module paths or relationships to map observations to LikeC4 elements;
- validate: return architecture-scoped semantic findings.

The POC does not install Memgraph, Qdrant, language packs, or a local model. A fixture with Code-Graph-RAG-shaped output is sufficient to prove the boundary.

## Stability Provider Thought Experiment

A stability provider belongs in `validate`. It can initially consume only the native LikeC4 model and later also use resolved implementation associations.

It can emit:

- `stability/metric` informational findings with `data.ca`, `data.ce`, and `data.instability`;
- `stability/stable-dependency` warnings or errors when dependencies point away from stability.

This uses the same `Finding` object as every other validator. No special metrics type is required.

## Explicit Non-goals

- No custom model snapshot.
- No duplicate LikeC4 graph representation.
- No full AST or Code-Graph-RAG graph in the core.
- No persistent graph or vector database.
- No generic provider registry or plugin lifecycle.
- No separate RAG phase.
- No automatic changes to `model.c4`.
- No generic code-quality finding aggregator.

## Acceptance Criteria

1. Native LikeC4 validation runs before the pipeline.
2. The deterministic scan/resolve/validate path works without configured external providers.
3. Providers receive the native LikeC4 model where needed.
4. Scan, resolve, and validate providers return only their standard result arrays.
5. Provider-specific structured values fit inside `Finding.data`, `Observation.data`, or `Association.data`.
6. Multiple validation providers merge into one compact report.
7. Stability metrics can be reported without adding a special metrics subsystem.
8. Code-Graph-RAG can be represented by a future adapter without changing the core objects.
9. No phase result contains a full AST, full provider graph, source dump, or long natural-language context.

## Fresh Review Questions

1. Is the native LikeC4 model sufficient as the only model object for in-process providers?
2. Is opaque provider-owned `data` flexible enough without becoming an unbounded dumping ground?
3. Should the POC use only imported TypeScript providers, with command execution deferred until after the function interfaces work?
4. Should stability begin as a model-only validator before it consumes implementation associations?
