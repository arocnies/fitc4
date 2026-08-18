# Agent-provider evals

An opt-in harness that measures the agent providers — `agentScan`, `agentResolve`, `agentOwnershipAdvisor`, `agentSemanticReview` — against fixtures with planted, known-correct answers. The fixtures double as checked-in end-to-end examples: three tiny projects showing how FitC4 fits code to a model, from a clean greenfield gate to a domain no TypeScript parser can see.

Nothing here runs in CI or under `npm test`, ever. The harness is invoked deliberately:

```bash
npm run eval                          # stub mode (default): free, deterministic, exact
npm run eval -- --fixture greenfield  # one fixture
npm run eval -- --exec claude         # live mode — read the cost note below first
```

## What a fixture is

Each directory under [`fixtures/`](fixtures/) is a self-contained project — a LikeC4 model in `arch/`, sources, and where the deterministic scanner applies, a real `fitc4.config.json` the eval loads (so the eval also proves the config valid). Three files carry the eval itself:

- **`fitc4.eval.ts`** — how the fixture composes the pipeline, as a function of the exec, so stub and live mode run through identical wiring.
- **`replies.json`** — the *recorded ideal agent*: the reply a perfect agent would give to each request, matched by content rather than call order.
- **`expectations.json`** — what a perfect run produces. `findings` is the complete finding set of that run; `associations`/`observations` `must` and `mustNot` entries pin agent behavior that never surfaces as a finding, such as the mapping `agentResolve` must make and the abstention it must keep.

## The two exec modes

**Stub mode (the default)** answers every agent request from `replies.json`. The whole run is then deterministic and free, which makes it a regression test of everything *except* the agent: fixtures, expectations, provider wiring, the pipeline itself. Anything short of a perfect scorecard exits nonzero, because an imperfect stub score means something in that plumbing broke — not that an agent had a bad day.

**Claude mode** (`--exec claude`, plus `--model`, default `haiku`) wires `cached(claudeCli({ model }))` and asks a real model the same questions. Cost notes, in order of importance:

- It shells out to your locally installed `claude` CLI — **your login, your billing**, one or more live calls per fixture on the first run.
- Successful replies are cached under `evals/.cache/` (gitignored), so a rerun with unchanged fixtures replays them for free; edit a fixture and only the affected requests go live again.
- This mode is for a human at a keyboard. Never wire it into CI — the harness's own gate is stub mode, which costs nothing.

A live score is a measurement, not a gate: claude mode prints the same scorecard but exits zero unless a fixture failed to run at all.

## Reading the scorecard

```text
fixture     provider                 hits  misses  extras  result
----------  -----------------------  ----  ------  ------  ------
greenfield  agent-resolve            1     0       0       ok
greenfield  architecture-rules       1     0       0       ok
brownfield  agent-ownership-advisor  1     0       0       ok
...
```

One row per provider, because the provider is the unit of judgment. **hits** are expected findings/associations/observations that appeared; **misses** are expected ones that did not; **extras** are emitted things nothing expected — an unexpected agent finding counts against the agent (the semantic reviewer flagging a healthy element is an extra), and a `mustNot` entry that appears is an extra with its own named note. Every miss and extra prints a detail line beneath the table. Deterministic providers (`architecture-rules`, `source-root`) are expected to be exact in both modes; in claude mode a wrong agent answer often shows up twice, honestly — once on the agent's row and once as the deterministic consequence (say, a `missing-relationship` extra caused by a wrong mapping).

## The three fixtures: fitting code to a model, in stages

**[`greenfield/`](fixtures/greenfield/)** — a small, clean TypeScript project whose deterministic gate passes. What is left over is exactly what no parser can map: `src/core` imports `stripe` and `@aws-sdk/client-s3`, external packages claimed by no element. `agentResolve` gets both as candidate decisions. `stripe` has one right answer — the description-only payments-gateway element, backed by a declared relationship — and must be mapped. The S3 client is genuinely ambiguous on purpose: the model declares *two* object-storage elements and nothing says which bucket the code touches, so the correct behavior is abstention, and mapping it is a named regression. Run the plain gate yourself: `node ../packages/fitc4/dist/cli.js` from the fixture directory passes with one info finding.

**[`brownfield/`](fixtures/brownfield/)** — a mid-size project carrying declared debt, the adoption story. The deterministic rules find everything on their own (the same CLI run exits 1 here): two `#drift` edges the code still exercises, one stale drift edge the ratchet wants deleted, one genuine `relationship-direction` violation, one unowned file. The agent providers add judgment on top: the semantic reviewer must flag `mono.core` — described as pure and I/O-free while `report.ts` writes to disk — and must *not* flag the honestly described `mono.ui`; the ownership advisor must suggest `mono.ui` for the unowned `src/render-helpers.ts`, whose entire import neighborhood is UI code.

**[`non-ts/`](fixtures/non-ts/)** — beyond TypeScript entirely, and the reason this harness exists as a set of examples: the first checked-in demonstration that `agentScan` can enforce a model domain no TypeScript parser sees. The implementation is a `docker-compose.yml`; the model declares custom `service` elements, each owning its build-context directory. `agentScan` runs in focused one-shot mode (the compose file's content is embedded in the request, and therefore in the `cached()` key), reports each `depends_on` edge as a `dependency` observation between the services' Dockerfiles, and attests to the file it examined. From there nothing is agent-specific: the stock resolver and rules judge compose edges exactly as they judge imports — `web → api` and `api → db` are declared and pass, while the planted `web → db` edge is forbidden by the model and surfaces as a `missing-relationship` error.

The progression is the point: the deterministic gate carries a greenfield project alone; agents extend it over a brownfield's judgment calls; and prose instructions extend it over domains with no parser at all — which is where a proven domain graduates to a small deterministic provider, per [`docs/agent-providers.md`](../docs/agent-providers.md).
