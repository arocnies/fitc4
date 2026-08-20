# FitC4 example

A minimal project under architecture control. Two components, one declared dependency:

- `example.app.core` (`src/core/`) holds the business logic and depends on nothing.
- `example.app.interface` (`src/interface/`) is the public API and may use Core (`interface -> core` in [`arch/model.c4`](arch/model.c4)).

## Run the check

```bash
npm run fitc4 -w example
```

A clean pass looks like this, with every file owned and every import inside a declared boundary:

```text
scan typescript-imports · resolve source-root · validate architecture-rules
4 observations · 3 associations · 0 errors, 0 warnings, 0 info
```

A clean pass is the least interesting thing this tool does, so break it.

## Exercise 1: cross a boundary

Create `src/core/bad.ts`, where Core reaches into Interface, the reverse of what the model declares:

```ts
import { status } from '../interface/index.js'

export const bad = status
```

Rerun `npm run fitc4 -w example`. Exit code 1:

```text
error (1)
  relationship-direction  example.app.core depends on example.app.interface, but the
  model declares only example.app.interface → example.app.core. Declare the
  dependency that the code actually has.
    src/core/bad.ts:1  ../interface/index.js
```

Two honest fixes: delete the import, or declare `example.app.core -> example.app.interface` in the model. The diagram then shows the cycle you just created, which is the point of keeping the model truthful. Delete `bad.ts` before moving on.

## Exercise 2: add unowned code

Create `src/util.ts` with anything at all:

```ts
export const shrug = '¯\\_(ツ)_/¯'
```

It sits under `src/` (scanned) but under neither component's `sources`, so the deterministic gate warns:

```text
warning (1)
  unmapped-source  src/util.ts is not owned by any model element.
```

Still exit 0. Unowned code is a nudge by default, promotable to an error with `architectureRules({ severity: { 'unmapped-source': 'error' } })` in a `.ts` config.

This is also the state where the agent variant has something to say. With a logged-in `claude` CLI:

```bash
npm run fitc4:agent -w example
```

runs the same gate plus [`fitc4.agent.config.ts`](fitc4.agent.config.ts). The ownership advisor reads `src/util.ts` and suggests which element should own it, or says the model is missing one. The semantic review judges each described component against its actual code. Without the CLI the run still passes and prints an `agent-unavailable` note instead. Delete `util.ts` when done.

## Exercise 3: declare drift and burn it down

Brownfield adoption in miniature. Recreate the Exercise 1 violation, `src/core/bad.ts` importing from Interface. This time suppose it is legacy code you cannot delete today. Instead of hiding it, declare it.

First, declare the tag at the top of the specification block in [`arch/model.c4`](arch/model.c4) (LikeC4 rejects undeclared tags):

```
specification {
  tag drift

  element system
  element container
  element component
}
```

Then declare the relationship the code actually has, tagged as drift, alongside the existing one in the model block:

```
example.app.core -> example.app.interface 'legacy reach-around' {
  #drift
}
```

Rerun `npm run fitc4 -w example`. The Exercise 1 error is now an info finding, plus a burn-down line. Exit 0:

```text
info (1)
  drift-relationship  example.app.core → example.app.interface is declared drift; 1 dependency still rides it. Remove the code path, then delete the tagged relationship from the model.
    src/core/bad.ts:1  ../interface/index.js

drift: 1 declared · 1 exercised · 0 unused
```

The debt is permitted, counted, and visible as an edge in the diagram. Now pay it down. Delete `src/core/bad.ts` and rerun. The edge flips to a warning demanding its own deletion:

```text
warning (1)
  unused-drift  example.app.core → example.app.interface is declared drift, but no code exercises it anymore. Delete the relationship: the model must not keep tolerating what stopped happening.

drift: 1 declared · 0 exercised · 1 unused
```

A drift edge the code stopped exercising has to go, or the model keeps permitting a dependency nothing needs. Delete the tagged relationship (and the `tag drift` line, since nothing else uses it) and the run is clean again. `severity: { 'unused-drift': 'error' }` in a `.ts` config makes that deletion mandatory. `{ 'drift-relationship': 'error' }` forbids tolerated drift entirely.

## Layout

```text
arch/model.c4        the contract: elements, sources ownership, allowed dependencies
fitc4.config.json    where things are: the config CI discovers and runs
fitc4.agent.config.ts   the same gate plus advisory agent providers, run on demand
AGENTS.md            norms for AI agents here: the model is the contract
src/                 the implementation being checked
```

One workspace-ism to not copy: this example's `fitc4.config.json` points `$schema` into the workspace (`../packages/fitc4/schema/...`). In your own project point it at `./node_modules/fitc4/schema/fitc4.config.schema.json`.

`npm run check -w example` chains model validation, typecheck, tests, and the gate. `npm run view -w example` opens the live LikeC4 diagram.
