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

### 2026-08-25: the 0.1.2 candidate sweep, a parser bug, and a rule the models corrected

The release measurement for 0.1.2, run after this branch changed the resolve prompt, the review defaults, the describe prompts, and the draft's rendered views and edge labels, so most of the suite ran live rather than replaying cache. Two evals were added first, both born from a brownfield end-to-end run no fixture resembled. `greenfield` now plants a junk drawer, an `External packages` element mirroring the measured live failure where a model mapped every driver and SDK onto the catch-all instead of the elements whose descriptions name them; `stripe` landing there is a named must-not regression. And `supabase/draft`'s compose container, the suite's one drafted pure container, now carries description rules on its pinned extra, so the description the describe pass synthesizes from its children is judged rather than merely replayed.

| exec · model | rows perfect | divergences |
|---|---|---|
| claude · sonnet | 46/46 | none, after the parser fix below |
| codex · gpt-5.6-luna | 45/46 | one, a reversed exploration edge |

Three things this sweep produced, in ascending order of how much they were worth.

**An accidental measurement of failing closed.** The first sonnet pass ran into an expired CLI OAuth session partway through. Every fixture needing a fresh call failed loudly: `provider-failure` errors carrying the CLI's own words ("OAuth session expired and could not be refreshed"), and the draft fixture aborted without writing a model. Nothing failed open, nothing thinned silently, and no placeholder description passed for a real one. That is exactly what the abstention/failure split exists to guarantee, measured at suite scale by accident.

**A real parser bug, found because a fail-closed path is unforgiving.** After re-login, `supabase/draft` still failed, now with "reply was not the requested JSON" on the container describe call. The reply was fine as prose and invalid as JSON: sonnet wrote a long description containing a literal newline inside the JSON string. One stray control character aborted a 35-element draft, and the error's excerpt is capped at 200 characters, so a cut-off reply and a badly formatted one read identically, which sent the first half of this diagnosis chasing the wrong cause. Two fixes. `extractJson` now escapes raw control characters inside string spans and retries, in the same spirit as the fence stripping that was already there, since a model writing across two lines emits invalid JSON carrying a completely unambiguous value; conformance is still enforced by `schemaMismatch` on whatever parses. And an unparseable reply now says whether it ended mid-value, because a truncated reply and a malformed one have different fixes. Both adapters share the repair and the distinction.

**A rule the models were right to fail.** With the parser fixed, sonnet and gpt-5.6-luna both drafted the compose container and both failed the same new rule, which demanded the container description say `postgres` or `database`. Their descriptions said "persistent data storage" (sonnet) and "shared persistence" (luna). Two independent strong models converging on the same answer against a rule written from one recorded ideal is evidence about the rule, not the models: it was testing the specificity of a word rather than the correctness of a claim, which the harness README explicitly says these rules are not for. The rule now accepts the concept in the words models actually use, and it still has teeth, since a description that never mentions data at all fails, and the ban on enumerating a minor child stands and both models passed it. Recorded because widening a rule to make a run pass is the cardinal sin of eval authoring and the reasoning deserves to be auditable: nothing about either description was wrong, and the fixture had encoded an author's phrasing as a requirement.

luna's one remaining divergence is exploration variance, not a regression: its exploratory scan emitted a reversed `alerts -> worker` edge alongside all eight required observations, the same extra haiku produced on 2026-08-18, on a fixture luna measured perfect on 2026-08-21. The deterministic rules rejected the edge downstream exactly as designed. Exploration remains the least constrained mode, where even a strong model sometimes reads a relationship backwards, and the advisory rules remain the reason that costs a scorecard row rather than a wrong gate.

The rest of the sweep held under the changed prompts: the new junk-drawer trap was resisted by both models (stripe onto the payments gateway, the S3 abstention kept, all five `slonik` decisions onto PostgreSQL with the new steer live), the default-instruction python scan stayed clean, and `misnamed/draft` stayed 4/4 including the describe-to-review loop.

### 2026-08-25: subtracting the carve-outs, and the listing the request never had

A second run the same day, this one asking a question about the fixtures rather than about the models: which sentences of fixture prose is the product leaning on? Every `agentScan` fixture writes instructions and has to, since FitC4 cannot know that a `_SERVICE_ADDR` env var means a dependency. But some clauses were not domain facts. They were corrections to the product, and a correction that lives in config is a defect hidden in the one place no user will look, because a user writing a first config does not know which sentence they are missing.

Four suspect clauses, one angle each, each subtracting exactly its clause through `harness/prose.ts`'s `without`, which throws if the clause is not there so a reworded base cannot silently turn an angle into a duplicate of the base run.

| angle | sonnet | gpt-5.6-luna | verdict |
|---|---|---|---|
| `ddh/greenfield@bare-resolve` | 5/5, 1/1 | 5/5, 1/1 | decoration |
| `supabase/greenfield@no-fragment-note` | 16/16, 12/12 | 16/16, 12/12 | decoration |
| `boutique/greenfield@no-path-hint` | 25/27, 2 warnings | 25/27, 2 warnings | load-bearing |
| `boutique/draft@no-exemption` | 11/12, 14/15 | scan died | load-bearing |

Two were decoration, which is the reassuring half. `ddh`'s resolve prose said to map a package onto "description-only elements that name the backing system a client package connects to", which IS the `slonik` onto `vendor.postgres` answer stated in the abstract; no user writes that sentence, because a user does not know yet which package is about to be ambiguous. Removing it changed nothing on either model. Same for the clause telling supabase's scan that fragments are banned in evidence and `examined`: both models worked out unaided that a citation is a file rather than a region.

The other two were real, and both models agreed on how. Asked for a stand-in Dockerfile under `src/<name>`, both independently wrote `src/cartservice/Dockerfile` for a file that lives at `src/cartservice/src/Dockerfile`. Those landed as dependency targets, the one position the guard forgives, so each run degraded to two lost edges and two `unresolved-import` warnings. In the draft variant the same class of guess lands as an observation SUBJECT, which throws, and luna's whole scan died on `src/redis-cart/Dockerfile`, a service the manifests deploy and no directory implements. Twenty-six observations discarded over one path.

**A fix that failed, twice, and made things worse.** The obvious reading was that the model needed to be told it could decline. So the shipped prompt gained a sentence: omit a fact whose path you cannot determine, never invent one, and here is why (one omission costs one observation, one invented path costs the scan). Luna invented the path anyway. Moved out of `PROMPT` and into the context directly beneath the instructions, on the theory that a general caveat one call away loses to a specific "emit one observation per service", it still invented the path, and the base `boutique/draft` row regressed from 12/12 to 11/12: luna now dropped `shoppingassistantservice`, a service it had been reporting correctly. Zero benefit, one real loss, in the fail-open direction that the gate cannot see. Reverted whole.

Worth recording as a negative result rather than a footnote, because the reasoning behind it was sound and wrong. Telling a model to hold back when it is unsure buys silence, and silence is the one outcome nothing downstream can flag.

**The actual cause: a one-shot scan was asked to attest to paths and shown none.** Focused mode embedded the focused files' contents and told the model those excerpts were its entire view of the repository. It never listed what else existed. So "every path must exist" was an instruction the model had no means to follow, and the fixtures had been quietly paying for that with hard-coded exceptions: the cartservice correction, and the redis-cart exemption whose second half ("only services with a build directory under src/ have a stand-in file") was not a workaround at all but the criterion itself, unavailable to a model that cannot see `src/`.

`composeFocusedContext` now adds an inventory: every file under `roots` whose contents no focus glob embedded, as paths only, after the excerpts so the excerpts keep budget priority and the inventory is what truncates. This is why `roots` and `focus` are separate options, and the split now has a statable meaning. `focus` chooses whose CONTENTS are embedded; `roots` chooses whose PATHS are known to exist. Boutique's roots widened to `['kubernetes-manifests', 'src']` and the request grew from 30.5KB to 38.1KB, no truncation, carrying all three facts the prose used to hard-code: `src/cartservice/src/Dockerfile` present, `src/cartservice/Dockerfile` absent, no `src/redis-cart` at all.

Both carve-outs then left the config, and both fixtures went green on both models with nothing about cartservice or redis-cart in their prose.

| row | sonnet | gpt-5.6-luna |
|---|---|---|
| `boutique/greenfield` | 27/27, 1/1, 15/15 | 27/27, 1/1, 15/15 |
| `boutique/greenfield@no-inventory` | 25/27, 2 warnings | 25/27, 2 warnings |
| `boutique/draft` | 12/12 elements, 15/15 edges | 12/12, 15/15 |
| `boutique/draft@no-inventory` | scan died | scan died |

The `no-inventory` angles are the control, narrowing `roots` back to the focused directory to restore the pre-inventory request shape, and they reproduce the old failures on both models. Note the draft angle died on different paths for different models, redis-cart for one and cartservice for the other, which is the point: the failure was never about one service. What no prompt wording achieved is visible in one detail of the fixed runs. Both models gave redis-cart no file observation while still including `shoppingassistantservice`, a distinction that requires knowing a directory is absent rather than merely unseen. A listing answers that. A sentence cannot.

**Whether `agentScan` should default to the whole repository.** It already does (`roots ?? ['.']`), and `supabase/greenfield@whole-repo` measures what that buys: the working config plus a second `agentScan({ exec })` with nothing configured, exploring the real Supabase tree, where upstream ships eleven alternative compose files (caddy, envoy, kong, nginx, pg15, pg17, pgbouncer, rustfs, s3, logs, dev) each declaring its own `services:` block for a deployment variant this architecture does not describe. A natural over-interpretation trap with nothing planted.

Sonnet produced 51 findings the model has no use for, and every one was a warning: 49 `unmapped-source` for infrastructure config the model never claimed, and 2 `unresolved-import` for paths leading out of the repository (a dev compose build context at `../apps/studio`, a container-internal `/etc/envoy/lds.yaml`). No errors. Not one invented edge between model elements. So over-interpretation in the sense that matters, fabricating a relationship that fails a gate on a correct model, did not happen; what a root-level scan costs is noise, and noise is the failure a human dismisses. The arithmetic behind most of it is unavoidable: the model claims compose fragments, so every file the scan reports is unowned and each is one warning.

Cost is the real caveat, and it showed up on the other exec. Luna's whole-repo scan split the 74-file tree into four batches, and the first attempt lost batch four to the 600s scan budget, with the CLI also reporting a dropped models-manager stream, so slowness and transport are entangled there. It failed closed as designed, one `provider-failure` error, completed batches cached for the resume.

**And the resume found a real gap, one ref kind wide.** On the rerun, batch two threw: `Agent scan reply named an invalid path in target: 'docker/volumes/storage' does not exist`. Luna had read a compose volume mount and reported `{ kind: 'directory', id: 'docker/volumes/storage' }`, a path the stack creates at runtime. The dependency-target downgrade, the documented carve-out that turns a missing target into an `unresolved-dependency` warning rather than a dead scan, only covered `kind: 'file'`. The identical claim written as a file would have cost one warning; written as a directory it cost a batch with nothing else wrong in it. That was an oversight rather than a policy, since a dependency pointing at something absent is a failed resolution whichever word the model chose, so the downgrade now covers both. Volume mounts are exactly the shape a root-level scan meets, so a whole-repo default is not usable without it.

Because the offending reply was already cached, the fix was verified against the exact reply that broke it, for free. Both models then agreed on the shape of the answer:

| exec · model | whole-repo findings | errors | invented edges |
|---|---|---|---|
| claude · sonnet | 51 warnings (49 `unmapped-source`, 2 `unresolved-import`) | 0 | none |
| codex · gpt-5.6-luna | 72 warnings (53 `unmapped-source`, 19 `unresolved-import`) | 0 | none |

Luna reported more, and the difference is almost entirely the volume mounts and container-internal paths its nineteen `unresolved-import` warnings name, every one of which used to be a candidate for killing the scan. Neither model produced a single error, and the `findingsMustNot` pins on `missing-relationship` and `relationship-direction` never fired on either. So the conclusion holds across both: pointing a scanner at a repository root buys noise, not corruption.

**A pin corrected, and why it counts as a mistake.** The whole-repo angle first pinned a wildcard: any dependency from a general import scan of this tree is invented, since nothing here imports anything repository-local. That is false. A compose file's build contexts and volume mounts are real references, and a model reporting them is being accurate, not credulous. The pin was labelling defensible observations as fabrications, which is the same authoring error as the description rule widened earlier today, in the opposite direction. It now pins `missing-relationship` and `relationship-direction` under `findingsMustNot`, the outcomes that would corrupt a gate, and lets the warnings accumulate as the measured cost.

Everything previously unmeasured came back clean live: `greenfield@bare-resolve`, `brownfield@default-agent`, `brownfield@deterministic`, `python@import-scan`, and `python@mixed`, the last being the first live confirmation of this branch's namesake claim, two scanners over one tree producing one finding carrying both citations. Stub sweep after all of it: 72 rows perfect, 26 of them angles.

### 2026-08-25: the near-zero tier, and the vocabulary the resolver did not speak

The suite's center of gravity moved. Until now every `agentScan` fixture ran on a domain oracle of 147 to 238 authored words, and the carve-out angles measured those essays one subtracted sentence at a time. The direction is now the opposite: the suite should mostly measure what a user gets before writing any of it, and prose that turns out to be load-bearing is a feature request against the tool, never a required part of a config. Four new angles built the ladder on the two prose-heaviest fixtures: `default-prompt` (no instructions at all, the shipped import-scan default) and `user-hint` (the one or two sentences a user would actually type — 21 words for boutique, 25 for supabase).

**The first live run found the feature request immediately.** Given the boutique hint — manifests deploy services implemented under `src/<name>`, `_SERVICE_ADDR` env vars name callees — both models independently answered in the natural vocabulary: `{ kind: 'service', id: 'checkoutservice' }`. Correct edges, correct evidence, the exact graph. The pipeline dropped every one of them without a single finding: `source-root` resolved only path-shaped refs, so each dependency landed as an unresolved association, and no rule speaks for those. Sonnet's supabase run was crueller. It wrote the *correct fragment locators* — `docker/docker-compose.yml#services.studio` — under `kind: 'service'`, and the same locator that resolves perfectly as a `file` ref vanished as a `service` ref, after which `unmatched-sources` fired eleven errors blaming the model for claims the scan had in fact touched. The eval harness itself was fooled in the other direction: the scorer matches observation ids and counted 13 hits while the pipeline resolved nothing.

**Three coordinated fixes, all in the tool, none in any config.** `source-root` now resolves a dependency ref by its id regardless of the kind the scanner chose: as a claimed path or fragment first (with a trailing-slash retry so directory ids land inside `dir/**` claims), then as an element name — full LikeC4 id or leaf, verbatim or spelling-insensitive, so `redis-cart` finds the `redis_cart` identifier LikeC4 forced and `api-gw` finds `apiGw`; a shared name resolves ambiguous, never guessed, and `module` refs are exempt because a package spelled like an element is a coincidence. `unmatched-sources` exempts elements that resolution reached by any vocabulary, keeping its typo'd-locator tripwire while ending the false blame. And a new `unmapped-reference` warning replaces the silence when named vocabulary maps onto nothing — scoped to name-speaking refs, because path refs already have `unmapped-source` and `unresolved-import`, and repeating those per edge would bury a brownfield report.

Replaying the same cached replies through the fixed pipeline, for free:

| row | before | after |
|---|---|---|
| boutique@user-hint · luna | 0/15 associations, 0 findings (silence) | 15/15, rules clean |
| boutique@user-hint · sonnet | 0/15 associations, 0 findings (silence) | 14/15, 11 honest `unmapped-source` warnings, one abstention surfaced by `unresolved-import` |
| supabase@user-hint · sonnet | 0/12 associations, 11 spurious `unmatched-sources` errors | 12/12, errors gone |
| supabase@user-hint · luna | 12/12 (it happened to say `kind: 'file'`) | 12/12, unchanged |

So the whole graph of both fixtures is now reachable from a two-sentence hint, and the only observation-level misses left on supabase are the three env-URL duplicates of edges `depends_on` already states — the oracle's bookkeeping convention, not information. Whether one model says `file` and another says `service` no longer changes the outcome, which is the point: ref-kind discipline was prompt tax the tool had no right to charge.

**The floors are pinned as floors.** `default-prompt` gets its own expectations on both fixtures, and they are honest in opposite registers. Boutique's floor is quiet — twelve manifests reported, twelve `unmapped-source` warnings, no edges, because an import scan finds no imports in YAML. Supabase's floor is loud — every fragment claim untouched inside an examined file, eleven `unmatched-sources` errors — and loud is correct: out of the box on a fragment-claimed model, fitc4 states that nothing got checked rather than passing green. The distance from either floor to the user-hint row is now the measured value of two sentences, and the distance from user-hint to the oracle is close to zero.

One deliberate line was drawn while scoping `unmapped-reference`: it does not fire on path-vocabulary edges whose endpoint is merely unowned, because `brownfield` immediately showed what that costs — two extra warnings restating what one `unmapped-source` already said, multiplied per import on any adoption-stage repository. The measured loss was named vocabulary vanishing; the rule covers exactly that.

Stub sweep after everything: 81 rows perfect, 36 of them from angles, including the four new ones — the boutique user-hint stub now records the service-name reply as the ideal, so name resolution is exercised on every CI run, not only live.

**Full cached sweep on both models, replayed through the fixed pipeline.** Sonnet and luna each score 71 rows ok. Every remaining FAIL row is a measured divergence the suite exists to display: the `no-inventory` angles still cost their two lost edges and one dead draft scan, `whole-repo` still buys its ~50 warnings of noise, `supabase@user-hint` still misses only the three duplicate-convention observations, and `boutique@user-hint` is *perfect* live for luna — the checked-in ideal reached from the 21-word hint — while sonnet's run adds eleven honest `unmapped-source` warnings for the manifest files it also reported and one surfaced abstention.

**One new measurement cuts the other way, and it stays.** Luna's first live pass on the zero-instruction resolve angles (`greenfield@bare-resolve`, `ddh/greenfield@bare-resolve`) tripped both `mustNot` pins that sonnet cleared: it mapped the deliberately ambiguous object-storage package and mapped nanoid onto a vendor catalog that covers no id generator. The shipped resolve prompt already says to omit any candidate it is not confident about, so this is not a missing sentence — it is the omission-rule lesson from the other direction: confidence calibration does not reliably arrive by prompt, on any model. What keeps it a scorecard row rather than a wrong gate is the downstream layer: the over-mapping surfaced immediately as a `missing-relationship` error against a correct model, exactly the visible failure the advisory design promises. No fix ships for this one; the row is the documentation, and it is the strongest current argument that `bare-resolve` belongs in every future sweep.
