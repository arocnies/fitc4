/**
 * The opt-in eval harness for the agent providers. Never part of `npm test`
 * or CI — run it deliberately:
 *
 *   npm run eval                      # stub mode: free, deterministic, exact
 *   npm run eval -- --exec claude     # live mode: YOUR claude CLI, YOUR bill
 *   npm run eval -- --exec codex      # live mode: YOUR codex CLI, YOUR bill
 *
 * Each fixture under `fixtures/` is a tiny self-contained project with a
 * LikeC4 model, planted ground truth, and three checked-in files:
 *
 * - `fitc4.eval.ts`     — how the fixture composes the pipeline, as a function
 *                         of the exec, so stub and live mode run the same wiring;
 * - `replies.json`      — the recorded ideal-agent reply per request;
 * - `expectations.json` — what a perfect run produces (see `harness/score.ts`).
 *
 * A fixture carrying `draft.eval.ts` instead runs `fitc4 draft` rather than
 * the gate: the spec composes the config `draft()` scans from, and the drafted
 * model is scored against a reference restatement of the known architecture
 * (see `harness/draft.ts`).
 *
 * Stub mode doubles as a regression test of the harness and the pipeline
 * wiring: everything in it is deterministic, so anything short of a perfect
 * score means a fixture or the plumbing broke — never the agent — and the
 * process exits nonzero. Live mode measures a real model against the same
 * expectations; its score is a measurement, not a gate, so it exits zero
 * unless a fixture failed to run at all.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { draft, runPipeline, type PipelineConfig, type ResolvedConfig } from 'fitc4'
import {
  cached,
  claudeCli,
  codexCli,
  DEFAULT_CLAUDE_MODEL,
  draftDescriber,
  type AgentExec,
} from 'fitc4/agent'

import { scoreDescribeReview, scoreDraft, type DraftExpectations } from './harness/draft.ts'
import { externalManifest, hasCheckout } from './harness/external.ts'
import { perfect, renderScorecard, scoreFixture, type Expectations, type FixtureScore } from './harness/score.ts'
import { scriptedExec, type ScriptedReply } from './harness/stub.ts'

/** The greenfield → brownfield → beyond-TypeScript → exploration progression, then external fixtures. */
const FIXTURE_ORDER = [
  'greenfield',
  'brownfield',
  'non-ts',
  'exploratory',
  'misnamed/draft',
  'ddh/greenfield',
  'ddh/brownfield',
  'ddh/draft',
  'boutique/greenfield',
  'boutique/brownfield',
  'boutique/draft',
  'ecom/greenfield',
  'ecom/brownfield',
  'supabase/greenfield',
  'supabase/brownfield',
  'supabase/draft',
]

type FixtureSpec = (exec: AgentExec, root: string) => PipelineConfig | Promise<PipelineConfig>

/** A draft fixture's spec composes the config `draft()` runs against instead. */
type DraftFixtureSpec = (exec: AgentExec, root: string) => ResolvedConfig | Promise<ResolvedConfig>

const { values: flags } = parseArgs({
  options: {
    exec: { type: 'string', default: 'stub' },
    // No parse-time default: the model default is per exec. claude falls back
    // to its cheap DEFAULT_CLAUDE_MODEL, codex to whatever its CLI defaults to.
    model: { type: 'string' },
    fixture: { type: 'string', multiple: true },
  },
})

if (flags.exec !== 'stub' && flags.exec !== 'claude' && flags.exec !== 'codex') {
  console.error(`unknown --exec '${flags.exec}'; use 'stub' (default), 'claude', or 'codex'`)
  process.exit(2)
}

const evalsDir = import.meta.dirname
const fixturesDir = path.join(evalsDir, 'fixtures')

/**
 * A fixture is any directory under `fixtures/` holding a `fitc4.eval.ts` (a
 * pipeline fixture) or a `draft.eval.ts` (a draft fixture, scored by
 * `harness/draft.ts`). A directory with neither may instead hold variant
 * fixtures one level down (`ddh/greenfield`, `boutique/draft`), which share
 * the parent's manifest, model, and patches.
 */
function hasSpec(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'fitc4.eval.ts')) || fs.existsSync(path.join(dir, 'draft.eval.ts'))
  )
}

function discoverFixtures(): string[] {
  const names: string[] = []
  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (hasSpec(path.join(fixturesDir, entry.name))) {
      names.push(entry.name)
      continue
    }
    for (const variant of fs.readdirSync(path.join(fixturesDir, entry.name), { withFileTypes: true })) {
      if (!variant.isDirectory()) continue
      if (hasSpec(path.join(fixturesDir, entry.name, variant.name))) {
        names.push(`${entry.name}/${variant.name}`)
      }
    }
  }
  return names
}

const discovered = discoverFixtures()
  .sort(
    (a, b) =>
      (FIXTURE_ORDER.includes(a) ? FIXTURE_ORDER.indexOf(a) : FIXTURE_ORDER.length) -
        (FIXTURE_ORDER.includes(b) ? FIXTURE_ORDER.indexOf(b) : FIXTURE_ORDER.length) ||
      a.localeCompare(b),
  )

const selected = flags.fixture === undefined ? discovered : flags.fixture
for (const name of selected) {
  if (!discovered.includes(name)) {
    console.error(`unknown fixture '${name}'; available: ${discovered.join(', ')}`)
    process.exit(2)
  }
}

if (flags.exec !== 'stub') {
  console.warn(
    `\nWARNING: --exec ${flags.exec} shells out to your locally installed \`${flags.exec}\` CLI.\n` +
      'Your login, your billing, one or more live model calls per fixture.\n' +
      'Successful replies are cached under evals/.cache/, so a rerun with\n' +
      'unchanged fixtures is free. This mode is for humans; never wire it into CI.\n',
  )
}

/**
 * The model actually in effect for the scorecard header. `--model` passes
 * through verbatim — users know their model ids better than this harness does.
 */
const model =
  flags.model ?? (flags.exec === 'claude' ? DEFAULT_CLAUDE_MODEL : undefined)

/** Build the exec one fixture runs against, per the `--exec` mode. */
function execFor(fixture: string): AgentExec {
  if (flags.exec === 'stub') {
    const replies = readJson(path.join(fixturesDir, fixture, 'replies.json')) as ScriptedReply[]
    return scriptedExec(fixture, replies)
  }
  // One cache directory for both CLIs is safe: `cached()` keys every entry on
  // the exec's `id` (which carries the CLI and model) and `fingerprint`, so a
  // reply recorded by one exec is never replayed as another's measurement.
  const directory = path.join(evalsDir, '.cache', 'fitc4-agent')
  // The external fixtures make big one-shot calls (a whole compose stack or
  // manifest set in one request); the adapters' 120s default proved tight
  // enough to time out on the first live pass, so eval runs get 5 minutes.
  const timeoutMs = 300_000
  if (flags.exec === 'claude') {
    return cached(claudeCli({ model, timeoutMs }), { directory })
  }
  // No `--model` passes nothing through, deferring to the codex CLI's own
  // default (the adapter runs codex isolated from ~/.codex/config.toml, so
  // that default is the CLI's built-in one; pass --model to override it).
  return cached(codexCli(model === undefined ? { timeoutMs } : { model, timeoutMs }), { directory })
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const scores: FixtureScore[] = []
const skipped: string[] = []

for (const fixture of selected) {
  const root = path.join(fixturesDir, fixture)

  // External fixtures never touch the network in a default run: with no
  // cached checkout they are skipped, and only naming one with --fixture is
  // permission to fetch (the fetch itself lives in the fixture's eval spec).
  const manifest = externalManifest(root)
  if (manifest !== undefined && !hasCheckout(evalsDir, manifest) && flags.fixture === undefined) {
    skipped.push(fixture)
    continue
  }

  let score: FixtureScore
  try {
    // A draft fixture runs `draft()` against the composed config, no model in
    // sight, and scores the drafted text against the reference expectations.
    // A spec that also exports `describe = true` opts into the describe pass:
    // the fixture's exec doubles as the draft describer, and the scorer then
    // asserts described elements carry non-TODO descriptions, plus whatever
    // per-element description rules the expectations declare. A spec that
    // exports `review = true` additionally gates the drafted model it just
    // wrote against `agentSemanticReview`, closing the describe-to-review loop.
    // Everything else runs the pipeline exactly as before.
    if (fs.existsSync(path.join(root, 'draft.eval.ts'))) {
      const expectations = readJson(path.join(root, 'expectations.json')) as DraftExpectations
      const specModule = (await import(pathToFileURL(path.join(root, 'draft.eval.ts')).href)) as {
        default: DraftFixtureSpec
        describe?: boolean
        review?: boolean
      }
      const exec = execFor(fixture)
      const config = await specModule.default(exec, root)
      const result = await draft(
        config,
        specModule.describe === true
          ? { describe: draftDescriber({ exec, repositoryRoot: config.repositoryRoot }) }
          : {},
      )
      score = scoreDraft(fixture, expectations, result)
      if (specModule.review === true) {
        score.providers.push(await scoreDescribeReview(config, exec, result))
        score.providers.sort((a, b) => a.provider.localeCompare(b.provider))
      }
    } else {
      const expectations = readJson(path.join(root, 'expectations.json')) as Expectations
      const specModule = (await import(pathToFileURL(path.join(root, 'fitc4.eval.ts')).href)) as {
        default: FixtureSpec
      }
      const result = await runPipeline(await specModule.default(execFor(fixture), root))
      score = scoreFixture(fixture, expectations, result)
    }
  } catch (error) {
    score = {
      fixture,
      error: `fixture did not run: ${error instanceof Error ? error.message : String(error)}`,
      providers: [],
    }
  }
  scores.push(score)
}

console.log(`\nexec: ${flags.exec}${flags.exec === 'stub' ? '' : ` (model: ${model ?? 'CLI default'})`}\n`)
console.log(renderScorecard(scores))
console.log('')

if (skipped.length > 0) {
  const flagList = skipped.map((name) => `--fixture ${name}`).join(' ')
  console.log(
    `note: external fixtures skipped, no cached checkout: ${skipped.join(', ')}. ` +
      `Fetch and run them with: npm run eval -- ${flagList}\n`,
  )
}

const allPerfect = scores.every(perfect)
const anyBroken = scores.some((score) => score.error !== undefined)

if (flags.exec === 'stub') {
  if (!allPerfect) {
    console.error(
      'stub mode scored imperfectly. The stub is the recorded ideal agent, so this is a\n' +
        'broken fixture, expectation, or pipeline wiring, not agent quality. Fix it.',
    )
    process.exit(1)
  }
  console.log('stub mode: perfect score. Fixtures, expectations, and pipeline wiring agree.')
} else {
  console.log(
    allPerfect
      ? 'live run matched the ideal-agent expectations exactly.'
      : 'live run diverged from the ideal-agent expectations; see the notes above.',
  )
  if (anyBroken) process.exit(1)
}
