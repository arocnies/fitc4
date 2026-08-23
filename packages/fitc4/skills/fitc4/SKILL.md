---
name: fitc4
description: Check code against the project's LikeC4 architecture model with fitc4. Use when running or interpreting the architecture gate, when a fitc4 finding appears in a build or report, or when asked whether a change fits the architecture.
---

# fitc4: fit the code to the model

The LikeC4 model (`.c4` files, usually under `arch/`) is a contract: which
elements exist, which files each owns (`sources` metadata), and which may
depend on which (`->` relationships). fitc4 scans the code, maps every file
and import onto that model, and fails where the two disagree.

## Run the gate

- `npx fitc4` reports to stdout and exits 1 when any finding has severity
  `error`.
- `npx fitc4 --json` prints the full structured result instead of the report
  (the `PipelineResult` type in `node_modules/fitc4/dist/index.d.ts`).
- `npx fitc4 --config <path>` uses a specific config instead of discovery.
- `npx fitc4 init` scaffolds a project that has no model yet. It writes a
  config, a starter `arch/model.c4` whose one element owns `src/**` so the
  first run is green, and an `AGENTS.md` carrying the norms below. It never
  overwrites an existing file.
- `npx fitc4 draft` generates a first-draft model from the code the
  configured scan providers observe: elements mirror the observed structure
  (a directory splits into nested elements where dependencies cross inside
  it and collapses where none do), one relationship per observed
  cross-element dependency, every relationship drift-tagged so the first run
  is green and the drift line counts the debt down. A draft for the human to
  rewrite, never a sync; it never overwrites an authored model, though it may
  replace `init`'s untouched placeholder, which says so on its first line
  (`--no-drift` emits plain relationships).

Run the gate before handing off changes. Exit 1 is an architecture violation,
not a flaky tool.

## Read the findings

Every finding carries a rule id and a severity:

- **error** fails the build: code crosses a boundary the model does not
  declare (`missing-relationship`) or crosses it against the declared
  direction (`relationship-direction`); two elements claim one file or
  package (`ambiguous-source`, `ambiguous-package`); or the model's own
  metadata is broken (`invalid-sources`, `unmatched-sources`,
  `invalid-packages`, `unmatched-packages`).
- **warning** passes but wants action: a file no element owns
  (`unmapped-source`), an import nothing can resolve (`unresolved-import`),
  a stale drift edge (`unused-drift`).
- **info** is counted, not blocking: exercised drift (`drift-relationship`),
  elements nothing checks (`unobserved-elements`).

Projects can tune severities, so trust the severity in the run you are
reading over the defaults above. Full rule reference:
`node_modules/fitc4/README.md#rules`.

## Fix the code, not the contract

A finding means the code and the contract disagree, and fixing the code is
the default:

- `missing-relationship` / `relationship-direction`: remove or reroute the
  offending import so the dependency flows the way the model declares.
- `unmapped-source`: new code needs an owner. Put the file under a directory
  an element's `sources` already covers, or extend the right element's
  `sources` (assigning ownership of new code is normal, not silencing).

Editing the model is a design decision, legitimate only when the architecture
genuinely changed, like a new component or a dependency the design now
accepts. Call any model change out explicitly when handing off. Never:

- edit the model merely to make a finding go away;
- delete `sources` metadata or a declared relationship to silence a finding,
  which removes code from architecture control entirely;
- add a `#drift` tag to get a new dependency past the gate (see below);
- soften a rule in the config's `severity` map to turn an error into a
  warning. How strict the gate is, is the team's call, not a step in fixing
  a finding.

## Drift etiquette

Relationships tagged `#drift` are tolerated-but-counted debt: dependencies
that really exist, declared honestly so brownfield code passes while the
report counts the debt down.

- Each exercised drift edge is one `drift-relationship` info finding; the
  fix is deleting the offending code path, then the tagged relationship.
- An `unused-drift` warning means no code exercises the edge anymore. The
  only fix is deleting the stale relationship from the model, never
  resurrecting code to keep it.
- Never add a drift tag to pass the gate. Drift declares debt that already
  existed, not debt being created.

## Package claims

`packages` metadata on an element claims exact npm package names (`pg`,
`@aws-sdk/client-s3`); imports of a claimed package resolve onto the claiming
element, and fitc4 checks them against boundaries like any file dependency.
An error on a claimed package import means route the code
through the claiming element, not delete the claim.
