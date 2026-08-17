# FitC4 example

A minimal project under architecture control. Two components, one declared dependency:

- `example.app.core` (`src/core/`) — business logic, depends on nothing.
- `example.app.interface` (`src/interface/`) — the public surface, allowed to use Core (`interface -> core` in [`arch/model.c4`](arch/model.c4)).

## Run the check

```bash
npm run fitc4 -w example
```

A clean pass looks like this — every file owned, every import inside a declared boundary:

```text
scan typescript-imports · resolve source-root · validate architecture-rules
4 observations · 3 associations · 0 errors, 0 warnings, 0 info
```

A clean pass is the least interesting thing this tool does, so break it.

## Exercise 1: cross a boundary

Create `src/core/bad.ts` — Core reaching into Interface, the reverse of what the model declares:

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

Two honest fixes: delete the import, or declare `example.app.core -> example.app.interface` in the model — at which point the diagram shows the cycle you just created, which is the point of keeping the model truthful. Delete `bad.ts` before moving on.

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

Still exit 0 — unowned code is a nudge by default, promotable to an error with `architectureRules({ severity: { 'unmapped-source': 'error' } })` in a `.ts` config.

This is also the state where the AI variant has something to say. With a logged-in `claude` CLI:

```bash
npm run fitc4:ai -w example
```

runs the same gate plus [`fitc4.ai.config.ts`](fitc4.ai.config.ts): the ownership advisor reads `src/util.ts` and suggests which element should own it — or says the model is missing one — and the semantic review judges each described component against its actual code. Without the CLI the run still passes and prints an `ai-unavailable` note instead. Delete `util.ts` when done.

## Layout

```text
arch/model.c4        the contract: elements, sources ownership, allowed dependencies
fitc4.config.json    where things are — the config CI discovers and runs
fitc4.ai.config.ts   the same gate plus advisory AI providers, run on demand
AGENTS.md            norms for AI agents working here — the model is the contract
src/                 the implementation being checked
```

`npm run check -w example` chains model validation, typecheck, tests, and the gate. `npm run view -w example` opens the live LikeC4 diagram.
