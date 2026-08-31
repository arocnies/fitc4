/**
 * The eval harness for the agent providers. Stub mode is deterministic and
 * free, and CI runs it on every push; live mode is opt-in and never CI's:
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
 * A spec may also export `angles`, alternative WIRINGS of the same project,
 * run as `<fixture>@<angle>`. The fixture's variants (greenfield, brownfield,
 * draft) vary the code; an angle varies the config over one fixed code state,
 * which is how the suite compares provider mixes: the deterministic scanner
 * against the agent scan on identical ground truth, a config with no agent at
 * all against the default one, the shipped prompt against fixture prose. An
 * angle reads `expectations.<angle>.json` when that file exists and the base
 * `expectations.json` when it does not, so an angle whose whole point is
 * reaching the SAME outcome by other means asserts exactly that, with no
 * second copy of the answer to keep in sync.
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

import { draft, runPipeline, type PipelineConfig, type ResolvedConfig } from '@arocnies/fitc4'
import {
  cached,
  claudeCli,
  codexCli,
  DEFAULT_CLAUDE_MODEL,
  draftDescriber,
  type AgentExec,
} from '@arocnies/fitc4/agent'

import { scoreDescribeReview, scoreDraft, type DraftExpectations } from './harness/draft.ts'
import { externalManifest, hasCheckout } from './harness/external.ts'
import { perfect, renderScorecard, scoreFixture, type Expectations, type FixtureScore } from './harness/score.ts'
import { scriptedExec, type ScriptedReply } from './harness/stub.ts'

/** The greenfield → brownfield → beyond-TypeScript → exploration progression, then external fixtures. */
const FIXTURE_ORDER = [
  'greenfield',
  'brownfield',
  'non-ts',
  'python',
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
  'otel/greenfield',
]

type FixtureSpec = (exec: AgentExec, root: string) => PipelineConfig | Promise<PipelineConfig>

/** A draft fixture's spec composes the config `draft()` runs against instead. */
type DraftFixtureSpec = (exec: AgentExec, root: string) => ResolvedConfig | Promise<ResolvedConfig>

/** What a fixture's spec file exports. `angles` are alternative wirings. */
interface SpecModule {
  default: FixtureSpec & DraftFixtureSpec
  angles?: Record<string, FixtureSpec & DraftFixtureSpec>
  describe?: boolean
  review?: boolean
}

/** One row-producing run: a fixture, optionally through one of its angles. */
interface Job {
  /** Scorecard label: `python` or `python@import-scan`. */
  id: string
  /** The fixture directory, shared by every angle (replies, manifest, sources). */
  fixture: string
  angle?: string
  isDraft: boolean
  spec: FixtureSpec & DraftFixtureSpec
  module: SpecModule
}

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
function specFile(dir: string): string | undefined {
  for (const name of ['fitc4.eval.ts', 'draft.eval.ts']) {
    if (fs.existsSync(path.join(dir, name))) return name
  }
  return undefined
}

function discoverFixtures(): string[] {
  const names: string[] = []
  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (specFile(path.join(fixturesDir, entry.name)) !== undefined) {
      names.push(entry.name)
      continue
    }
    for (const variant of fs.readdirSync(path.join(fixturesDir, entry.name), { withFileTypes: true })) {
      if (!variant.isDirectory()) continue
      if (specFile(path.join(fixturesDir, entry.name, variant.name)) !== undefined) {
        names.push(`${entry.name}/${variant.name}`)
      }
    }
  }
  return names
}

const orderOf = (name: string): number =>
  FIXTURE_ORDER.includes(name) ? FIXTURE_ORDER.indexOf(name) : FIXTURE_ORDER.length

const fixtures = discoverFixtures().sort(
  (a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b),
)

/**
 * Expand each fixture into its base job plus one per declared angle.
 *
 * Importing a spec module has no side effects — every fixture does its
 * checkout and assembly inside the exported function — so reading `angles`
 * up front costs one import per fixture and keeps `--fixture` able to name an
 * angle directly.
 */
const jobs: Job[] = []
for (const fixture of fixtures) {
  const root = path.join(fixturesDir, fixture)
  const file = specFile(root)
  if (file === undefined) continue
  const module = (await import(pathToFileURL(path.join(root, file)).href)) as SpecModule
  const isDraft = file === 'draft.eval.ts'
  jobs.push({ id: fixture, fixture, isDraft, spec: module.default, module })
  for (const [angle, spec] of Object.entries(module.angles ?? {})) {
    jobs.push({ id: `${fixture}@${angle}`, fixture, angle, isDraft, spec, module })
  }
}

/**
 * `--fixture python` selects python and every angle of it, because comparing
 * the angles is the point of having them; `--fixture python@mixed` names one.
 */
const selected =
  flags.fixture === undefined
    ? jobs
    : jobs.filter((job) =>
        (flags.fixture ?? []).some((name) => job.id === name || job.fixture === name),
      )

if (flags.fixture !== undefined) {
  for (const name of flags.fixture) {
    if (!jobs.some((job) => job.id === name || job.fixture === name)) {
      console.error(`unknown fixture '${name}'; available: ${jobs.map((job) => job.id).join(', ')}`)
      process.exit(2)
    }
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

/**
 * An angle's expectations, falling back to the fixture's own.
 *
 * The fallback is the useful case, not a shortcut: an angle that reaches the
 * same outcome by different wiring (a deterministic scanner matching an agent
 * scan, the shipped prompt matching fixture prose) states that by sharing the
 * answer key rather than duplicating it.
 */
function expectationsFor(job: Job): unknown {
  const root = path.join(fixturesDir, job.fixture)
  if (job.angle !== undefined) {
    const specific = path.join(root, `expectations.${job.angle}.json`)
    if (fs.existsSync(specific)) return readJson(specific)
  }
  return readJson(path.join(root, 'expectations.json'))
}

const scores: FixtureScore[] = []
const skipped: string[] = []

for (const job of selected) {
  const root = path.join(fixturesDir, job.fixture)

  // External fixtures never touch the network in a default run: with no
  // cached checkout they are skipped, and only naming one with --fixture is
  // permission to fetch (the fetch itself lives in the fixture's eval spec).
  const manifest = externalManifest(root)
  if (manifest !== undefined && !hasCheckout(evalsDir, manifest) && flags.fixture === undefined) {
    skipped.push(job.id)
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
    if (job.isDraft) {
      const expectations = expectationsFor(job) as DraftExpectations
      const exec = execFor(job.fixture)
      const config = await job.spec(exec, root)
      const result = await draft(
        config,
        job.module.describe === true
          ? { describe: draftDescriber({ exec, repositoryRoot: config.repositoryRoot }) }
          : {},
      )
      score = scoreDraft(job.id, expectations, result)
      if (job.module.review === true) {
        score.providers.push(await scoreDescribeReview(config, exec, result))
        score.providers.sort((a, b) => a.provider.localeCompare(b.provider))
      }
    } else {
      const expectations = expectationsFor(job) as Expectations
      const config = await job.spec(execFor(job.fixture), root)
      const result = await runPipeline(config)
      score = scoreFixture(job.id, expectations, result, { repositoryRoot: config.repositoryRoot })
    }
  } catch (error) {
    score = {
      fixture: job.id,
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
  const flagList = [...new Set(skipped.map((name) => name.split('@')[0]))]
    .map((name) => `--fixture ${name}`)
    .join(' ')
  console.log(
    `note: external fixtures skipped, no cached checkout: ${skipped.join(', ')}. ` +
      `Fetch and run them with: npm run eval -- ${flagList}\n`,
  )
}

// Floors are measured snapshots, not targets: their drift is printed and
// deliberately kept out of every exit-code decision.
const gated = scores.filter((score) => score.floor !== true)
const floorDrift = scores.filter((score) => score.floor === true && !perfect(score))
const allPerfect = gated.every(perfect)
const anyBroken = gated.some((score) => score.error !== undefined)

if (floorDrift.length > 0) {
  console.log(
    `note: floor rows drifted from their snapshots (never failing): ${floorDrift
      .map((score) => score.fixture)
      .join(', ')}. If the drift is an improvement, re-snapshot the floor expectations.\n`,
  )
}

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
