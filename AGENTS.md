# Agent instructions

This repository builds `fitc4`, a library and CLI that checks an implementation against a LikeC4 architecture contract. `packages/fitc4` is the tool. `example/` is a project it checks, standing in for a consumer. Treat it as a fixture with a README's worth of responsibility, not as scratch space.

Run `npm run verify` before handing off a change. It builds the package, runs its tests, and then runs the built binary against the example. Before anything publish-shaped, meaning a change to `files`, `exports`, `bin`, or the schema location, also run `npm run smoke`. It packs the real tarball and installs it into a throwaway consumer. Workspace symlinks cannot catch mistakes in those fields.

## Boundaries

- Nothing in `packages/fitc4` may assume it lives in the repository it checks. Paths come from the config or the working directory, never from `import.meta.url`.
- `src/cli.ts` runs the pipeline on import, so nothing else may import it. Anything the CLI can do must also be reachable from `src/index.ts`.
- Providers are plain functions composed into the config's phase arrays, and the arrays are required: there are no default phases, so a config names everything that runs (`docs/providers.md`). There is no registry, lifecycle, or discovery system, and adding one is a design change rather than a refactor.
- `src/agent/` is the `@arocnies/fitc4/agent` entry point and nothing in core may import it. The self-check enforces that boundary. Agent findings are additive; each provider's `severity` option says whether it is advisory (the default) or part of the gate. `'error'` also escalates `agent-unavailable` and `agent-truncated`, because a gate whose judge is absent must not pass.
- The LikeC4 model is the only architecture-model representation. Do not build a snapshot type that duplicates elements or relationships.

## The gate must never fail open

This is the property the whole tool exists for, and most of its rules exist because it was violated once. A check that silently reports nothing is worse than no check, because it looks like success.

- Metadata that matches nothing, a provider that misbehaves, a scan root that does not exist, and a finding with an unrecognized severity are all errors, never silent omissions.
- When adding a rule or a provider, ask what its output looks like when its input is empty or malformed. If that case is indistinguishable from a clean run, it needs a finding.
- Derive the identifiers you report to users from author-controlled names, never from LikeC4's generated relationship hashes, which are unstable across runs.

## Data and vocabulary

- `Observation.kind` and `Ref.kind` are the cross-provider contract. The standard set lives in `src/kinds.ts`; extend it there rather than introducing a bare string literal in a provider. Kinds stay open, but a kind the standard rules do not read is reported, never silently dropped.
- Anything every provider must rely on belongs in the `Observation` / `Association` / `Finding` envelope, not in `data`.
- The core never interprets a provider's `data`; it only checks that it is serializable. Providers may read each other's `data`, but a provider that does so owns the coupling. There is no schema negotiation.

## The model and the config

- Treat `example/arch/model.c4` as a design contract, not an implementation scratch file. Keep module boundaries and relationship ownership explicit in it.
- Keep implementation changes separate from architecture changes unless the design contract itself is changing.
- `fitc4.config.mts` belongs at a project's root. `.fitc4/` is a supported fallback for the config only. The model stays visible, wherever `model` points.
- `fitc4` depends on TypeScript 6 for the compiler API; `example` typechecks with TypeScript 7.
