# Measured results

The dated log of live eval runs. The harness, the fixtures, and how to read a
scorecard are in the [eval README](README.md).

Reruns replay the cache, so a fresh measurement needs a fixture edit or a cleared `evals/.cache/`.

### 2026-08-18: the four checked-in fixtures

First live measurements, one run per model over the four checked-in fixtures (12 provider rows).

| exec · model | rows perfect | divergences |
|---|---|---|
| claude · sonnet | 12/12 | none, matched the ideal-agent expectations exactly |
| codex · gpt-5.6-luna | 12/12 | none, matched exactly after two codex-adapter fixes this run surfaced, see below |
| claude · haiku | 9/12 | two precision failures, zero misses on these fixtures: the semantic reviewer flagged the healthy `mono.ui` (brownfield), and exploration emitted a reversed `alerts -> worker` edge the deterministic rules correctly rejected (exploratory, one extra on two rows) |

This run read as "every divergence is an extra, never a miss". That held on these four fixtures and was falsified three days later on the external ones; the corrected reading is under 2026-08-21 below. What did survive is that the harness paid for itself on its first live outing: the codex path's first real execution found two adapter bugs. OpenAI strict mode demands every property be `required`, so optionals now travel as required-but-nullable and are stripped on reply. It also rejects array-rooted schemas, which now travel in an object envelope. Both bugs were invisible to stub mode by design; both failed closed as `provider-failure` errors rather than thinning the run silently.

### 2026-08-21: the full 35-row suite, external fixtures included

One pass per model over the thirteen fixtures with an agent in the loop (35 provider rows; `ddh/draft`, added since, is deterministic and has no live question to ask, and `supabase/draft`, also added since, still awaits its first live pass). The harness paying for itself on live outings stayed the theme: the first pass over the full suite exposed two harness defects, fixed in commit e2d2739 before the pass that counts. The `boutique/draft` instructions forced every model to invent a stand-in path for redis-cart, which the fail-closed path guard rejected, killing the whole scan, a defect stub mode could never see; and the adapters' 120s timeout proved too tight for the big one-shot external scans, so eval runs now allow 5 minutes.

| exec · model | rows perfect | divergences |
|---|---|---|
| claude · sonnet | 35/35 | none, matched the ideal-agent expectations exactly |
| codex · gpt-5.6-luna | 35/35 | none, matched exactly |
| claude · haiku | 30/35 | the two extras of the 2026-08-18 baseline, unchanged, plus the first measured misses, see below |

haiku's extras were the familiar pair: the semantic reviewer flagged the healthy `mono.ui`, and exploration emitted a reversed `alerts -> worker` edge the deterministic rules rejected. New, and more important: haiku produced the first measured misses. On `supabase/brownfield` its scan did not report the planted `auth -> functions` edge (the enabled send-email hook, a single-line signal in a large compose file), so the planted violation passed the gate undetected, and three scorecard rows fell at once: the scan observation, the association, and the `missing-relationship` finding were all absent. On `boutique/draft` it missed `shoppingassistantservice` entirely, 1 element and 1 edge, with zero extras.

The draft eval's live numbers: sonnet drafted 12/12 elements and 15/15 edges with 0 extras, gpt-5.6-luna the same, haiku 11/12 elements and 14/15 edges with 0 extras.

### 2026-08-22: describe, and the first oracle that can lose

Two measurements the same day the describe pass landed.

First, `supabase/draft`'s describe leg, re-measured after each change to the request. The initial run exposed a defect stub mode could not see: a fragment element's owned file is the whole containing file, so a head-of-file excerpt routinely missed the very section the element claims. sonnet said so honestly ("cannot be determined from the shown files"); gpt-5.6-luna filled the gap with plausible sentences assembled from the element's name. Anchoring the excerpt window at the claimed fragment, preferring its definition line over an earlier reference to it, took both models to 11 of 11 accurate descriptions. A later prompt change, steering toward durable responsibility and away from configuration, measurably reduced trivia: sonnet's mentions of ports, environment variables, and image tags fell from 6 to 2 across the same eleven elements, and the descriptions moved from listing settings to stating why another component would depend on this one.

Second, `misnamed/draft`, whose whole purpose is to be losable. Its rules demand the real responsibility and forbid the wrong concept, so a description assembled from a misleading directory name fails a row rather than passing for being non-empty.

| exec · model | rows perfect | divergences |
|---|---|---|
| claude · sonnet | 4/4 | none |
| codex · gpt-5.6-luna | 4/4 | none |
| claude · haiku | 3/4 | described the entry point's mechanics and never its role, see below |

None of the three fell for a misleading name, so gullibility is not what this fixture caught. haiku's `src/legacy/` description was accurate about mechanics and silent about architecture: "handles HTTP requests for payment settlement, refunds, and ledger balance lookups, enforcing principal-based authorization and converting authorization failures into HTTP 403 responses", never that this is the process entry point through which every request arrives. sonnet and gpt-5.6-luna both said it. This is a fourth measured haiku failure mode, and the one most specific to this tool's purpose: a description that omits an element's architectural role is exactly the description an architecture model cannot use.

The review row paid for itself on the same run. gpt-5.6-luna described the ledger as immutable, and the semantic reviewer, reading the code behind that claim, reported that `postEntry` stored the caller's mutable object reference, so entries could be rewritten after recording. It was right: the fixture's own code contradicted its own comment. The fix was to copy and freeze the entry, after which the row went clean. Two things worth recording. The describe-to-review loop's first live outing produced a true positive rather than the feedback noise it was built to detect, and haiku reviewed its own near-identical immutability claim without objection, so a reviewer's strength matters as much as a describer's.

The corrected reading. The earlier claim that a measured divergence is always an extra, never a miss, is falsified. sonnet-class and luna-class models measure perfect across the whole suite. haiku-class models both over-report and, newly measured, under-report on subtle single-line signals in large files. The two failure directions are not symmetric: an extra surfaces for a human to dismiss, but an agent-scan miss is a fail-open outcome the gate cannot see, because nothing downstream can flag an observation that never arrived. That is the measured argument for the advisory-first stance, whose failure mode is noise, and for graduating proven domains to deterministic providers; for a fail-closed scan that gates a merge, it is also the measured case for a sonnet-class model over the cheap default.

### 2026-08-24: the default instructions, measured

The `python` fixture landed the same day `agentScan`'s `instructions` became optional, so the shipped default, the general import scan, got its first live measurement instead of shipping on faith. One run per model over the fixture's 11 rows: three scan attestations, four dependency observations (the planted forbidden import and the external `yaml` module among them), three resolved associations, and the `missing-relationship` error. The stdlib imports (`json`, `typing`, `pathlib`) are pinned as must-not observations, so a chatty model loses a row rather than passing quietly.

| exec · model | rows perfect | divergences |
|---|---|---|
| claude · haiku | 11/11 | none, after the exploration-note fix below |
| claude · sonnet | 11/11 | none |
| codex · gpt-5.6-luna | 11/11 | none |

The first haiku pass paid for itself: the scan died with the model asking permission to read paths it had invented. It cannot ask for its working directory, so it glued the listed repository-relative paths onto a guessed absolute prefix, fed those to its read tool, and gave up when they were refused, even though the tools accept the listed paths as written. Two probe calls confirmed both halves (Glob and Read work relative; the model does not know its cwd), and the fix is one deterministic sentence appended to the agentic prompt: your working directory is the repository root, pass the paths as listed, never prefix them. After it, all three models, the cheap default included, measured perfect, and the standard-library discipline held: no model reported `json`, `typing`, or `pathlib`.

### 2026-08-25: the 0.1.2 candidate sweep, with two new losable rows

The release measurement for 0.1.2, run after this branch changed the resolve prompt, the review defaults, the describe prompts, and the draft's rendered views and edge labels, so most of the suite ran live rather than replaying cache. Two evals were added first, both born from the brownfield end-to-end run that no fixture resembled. `greenfield` now plants a junk drawer, an `External packages` element mirroring the measured live failure where a model mapped every driver and SDK onto the catch-all instead of the elements whose descriptions name them; `stripe` landing there is a named must-not regression. And `supabase/draft`'s compose container, the suite's one drafted pure container, now carries description rules on its pinned extra, so the description the describe pass synthesizes from its children is judged rather than merely replayed.

| exec · model | rows perfect | divergences |
|---|---|---|
| codex · gpt-5.6-luna | 46/48 | two, both informative, see below |
| claude · sonnet | not measured | the CLI's OAuth session expired mid-sweep; every row needing a fresh call failed closed, rerun pending |

The sonnet column is an infrastructure result, not a quality one, and it is worth recording anyway: a logged-out CLI produced loud `provider-failure` errors on every fixture that needed it, `agent-unavailable` carrying the CLI's own words ("OAuth session expired and could not be refreshed"), and the one draft fixture aborted without writing a model. Nothing failed open. That is the exact behavior the abstention/failure split exists to guarantee, measured accidentally at suite scale.

gpt-5.6-luna's two divergences:

- **The container rule caught its first live description.** Asked to describe the compose stack from its eleven children, luna wrote abstraction: "Provides the coordinated runtime foundation for application data, identity, APIs, storage, realtime updates, edge functions, and project administration...", a category-by-category restatement of the child list that never says what the thing is or names the database at its center. The row failed on `postgres|database`. (The run also refined the other rule: luna's "running platform" is a fair way to say what the whole is, so `platform` joined `stack|deployable|self-host` as an accepted alternative; the database omission stands as the miss.) Every one of luna's eleven per-service descriptions passed, so the measured weakness is specifically synthesis from children, the one describe mode with no code in the context.
- **Exploration variance, previously a haiku-only failure.** luna's exploratory scan emitted a reversed `alerts -> worker` edge alongside all eight required observations, the same reversed-edge extra haiku produced on 2026-08-18, and the deterministic rules rejected it downstream exactly as designed. luna had measured perfect on this fixture on 2026-08-21, so the failure mode is variance in the least constrained mode, not a regression in the fixture or the prompt: exploration remains the mode where even a strong model sometimes reads a relationship backwards, and the advisory rules remain the reason that costs a scorecard row rather than a wrong gate.

The rest of the sweep held under the changed prompts: the junk-drawer trap was resisted (stripe onto the payments gateway, the S3 abstention kept, all five `slonik` decisions onto PostgreSQL with the new steer live), the default-instruction python scan stayed clean, and `misnamed/draft` stayed 4/4 including the describe-to-review loop.
