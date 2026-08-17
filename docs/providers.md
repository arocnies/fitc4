# Writing a provider

A provider is a plain async function. There is no registry, lifecycle, or discovery system: providers are composed into phase arrays, either in code through `runPipeline`, or in a `soffit.config.ts` / `soffit.config.js` whose default export the CLI loads. The pipeline runs

```
native LikeC4 validation → scan → resolve → validate → report
```

and each phase has one provider type, defined in [`packages/soffit/src/types.ts`](../packages/soffit/src/types.ts):

| Phase | Type | Receives | Returns |
|---|---|---|---|
| scan | `ScanProvider` | `ScanContext` — `repositoryRoot`, the `sources` prefixes declared in the model, `changedPaths` (always empty for now) | `Observation[]` — implementation facts |
| resolve | `ResolveProvider` | `ResolveContext` — the LikeC4 `model`, all `observations`, `repositoryRoot`, `sources` | `Association[]` — mappings from observations onto the model |
| validate | `ValidateProvider` | `ValidateContext` — `model`, `observations`, `associations`, `repositoryRoot`, `sources` | `Finding[]` — judgments with a severity |

A scan provider knows nothing about the model beyond the ownership prefixes; a resolve provider maps facts onto the model without judging them; a validate provider judges and never gathers. Deviating from that split works mechanically, but the standard providers assume it.

## The envelope and `data`

`Observation`, `Association`, and `Finding` are the envelope. Anything every provider must be able to rely on belongs in the envelope's named fields — `kind`, `subject`, `target`, `evidence`, `severity`, `candidates` — not in `data`. The core never interprets `data`; it only checks that it survives a JSON round trip (cycles, `undefined`, functions, `Map`, `NaN`, class instances are all rejected, and the rejection fails the provider). Providers may read each other's `data`, but a provider that does so owns the coupling: there is no schema negotiation, and nothing warns when the shape changes.

## The kind vocabulary

`Observation.kind` and `Ref.kind` are the one contract that crosses provider boundaries, named in [`packages/soffit/src/kinds.ts`](../packages/soffit/src/kinds.ts).

Standard observation kinds: `file` (a source file exists and is in scope for ownership), `dependency` (`subject` depends on `target`), `unresolved-dependency` (a dependency whose target could not be resolved), `scan-root` (a path the provider actually looked at — the coverage attestation).

Standard ref kinds: `element`, `relationship` (the model), `file`, `directory`, `module`, `symbol` (the repository), `observation`, `provider` (the pipeline). `symbol` is reserved: it is in the vocabulary so two providers that want it agree on its name, but nothing emits it yet.

The vocabulary is open — a provider may emit its own kinds, and two providers that understand each other's private kinds may cooperate. What the standard set buys is a default that works: emit these and the standard rules understand you. An observation kind outside the standard set is legal but unread by the standard rules, which report it at `info` severity (`unknown-observation-kind`) rather than passing silently.

The set is versioned with the package: adding a standard kind is a minor version, changing a kind's meaning is a major version.

## Ids

Emit natural keys — `file:src/index.ts`, `dependency:src/a.ts:12->./b.ts`. The core prefixes every id with the provider's composed id, so two providers cannot collide on the same natural key. Two consequences: an id must be unique within your own output (a duplicate fails the provider), and an `Association.observationId` must be the namespaced id as received in `context.observations`, not a rebuilt natural key — a rebuilt key points at nothing, and the core reports it (`orphaned-association`) instead of letting the association silently drop.

## Failure

A provider that throws becomes one `error` finding (`provider-failure`) attributed to that provider; the other providers still run. Output is staged and committed as a unit, so a provider that fails partway contributes nothing — half a result is a misleading one. Do not catch your own errors to return a partial result; throw, and let the attribution machinery report it.

## Never fail open

The property the whole tool exists for: a check that silently reports nothing is worse than no check, because it looks like success. Concretely — a scan provider that means `dependency` but emits `import` produces observations no rule reads, therefore zero findings and exit 0, indistinguishable from a genuinely clean repository. That is why unknown kinds are reported rather than skipped. When writing a provider, ask what its output looks like when its input is empty or malformed; if that case is indistinguishable from a clean run, it needs a finding.

## A complete `soffit.config.ts`

A phase array present in the config replaces the preset for that phase entirely — present replaces, absent defaults. There are no merge semantics; a config that extends a phase rebuilds the preset entries explicitly, using the exported providers and their exported ids, so the composition is visible in the file that owns it.

```ts
import {
  architectureRules,
  ARCHITECTURE_RULES_PROVIDER_ID,
  defineConfig,
  type Finding,
  type ValidateContext,
} from 'soffit'

const PROVIDER_ID = 'import-budget'
const BUDGET = 20

/** Flag any file with more dependencies than the budget allows. */
async function importBudget(context: ValidateContext): Promise<Finding[]> {
  const counts = new Map<string, number>()
  for (const observation of context.observations) {
    if (observation.kind !== 'dependency') continue
    const file = observation.subject?.id
    if (file !== undefined) counts.set(file, (counts.get(file) ?? 0) + 1)
  }

  return [...counts]
    .filter(([, count]) => count > BUDGET)
    .map(([file, count]) => ({
      id: `import-budget:${file}`,
      ruleId: 'import-budget',
      severity: 'warning' as const,
      description: `${file} has ${count} dependencies; the budget is ${BUDGET}.`,
      subject: { kind: 'file', id: file },
      provider: PROVIDER_ID,
    }))
}

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',
  // Present replaces: this array is the whole validate phase, so the preset
  // rule set is rebuilt here alongside the addition. scan and resolve are
  // absent and keep their preset defaults.
  validate: [
    { id: ARCHITECTURE_RULES_PROVIDER_ID, run: architectureRules },
    { id: PROVIDER_ID, run: importBudget },
  ],
})
```

Discovery checks `soffit.config.ts`, `soffit.config.js`, then `soffit.config.json` — in the working directory and its `.soffit/`, then each ancestor. Two of the three in one directory is an error, because whichever lost a tiebreak would be a silently ignored config. A replaced scan phase rebuilds its preset entry the same way, with `typescriptImports({ tsconfigPath, roots })` under `TYPESCRIPT_IMPORTS_PROVIDER_ID`; resolve, with `sourceRoot` under `SOURCE_ROOT_PROVIDER_ID`.
