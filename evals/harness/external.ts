/**
 * External fixtures: pinned upstream repositories, fetched on demand.
 *
 * An external fixture checks in only what we author (model, config, eval
 * files, patches) plus an `external.json` manifest naming the upstream
 * repository and the commit it is pinned to. The sources themselves are never
 * vendored: they are cloned once into `evals/.cache/repos/` (gitignored) and
 * reused from there.
 *
 * The offline contract lives in two halves. `hasCheckout` is the cheap local
 * probe `run.ts` uses to decide whether an external fixture can run at all:
 * with no cached checkout and no explicit `--fixture` selection, the fixture
 * is skipped with a note instead of touching the network. `ensureCheckout` is
 * the fetching half, reached only from a fixture's own `fitc4.eval.ts`, which
 * `run.ts` only imports once the skip decision already allowed the fixture to
 * run. A cached checkout is verified against the pin (`git rev-parse HEAD`)
 * on every use, so a stale or tampered cache fails loudly rather than scoring
 * the wrong code.
 *
 * Per run, `assembleWorkdir` builds a disposable working directory under
 * `evals/.cache/work/`: the pristine checkout minus `.git`, our overlay files
 * (the LikeC4 model and the fitc4 config) copied on top, and optionally the
 * fixture's patches applied with `git apply`. The checkout itself is never
 * written to, so greenfield and brownfield variants can share it.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const MANIFEST_FILENAME = 'external.json'

export interface ExternalManifest {
  /** Clone URL of the upstream repository. */
  repository: string
  /** The full commit SHA the fixture is pinned to. */
  commit: string
}

/**
 * The manifest governing a fixture directory, if any.
 *
 * Variant fixtures (`ddh/greenfield`, `ddh/brownfield`) share one manifest in
 * their parent directory, so the parent is checked when the fixture itself
 * carries none.
 */
export function externalManifest(fixtureDir: string): ExternalManifest | undefined {
  for (const dir of [fixtureDir, path.dirname(fixtureDir)]) {
    const file = path.join(dir, MANIFEST_FILENAME)
    if (!fs.existsSync(file)) continue
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ExternalManifest>
    if (typeof parsed.repository !== 'string' || typeof parsed.commit !== 'string') {
      throw new Error(`${file} must carry string 'repository' and 'commit' fields`)
    }
    return { repository: parsed.repository, commit: parsed.commit }
  }
  return undefined
}

/** Where the pinned checkout lives, keyed by repository name and commit. */
export function checkoutDir(evalsDir: string, manifest: ExternalManifest): string {
  const name = path.basename(manifest.repository).replace(/\.git$/, '')
  return path.join(evalsDir, '.cache', 'repos', `${name}-${manifest.commit}`)
}

/** Whether a usable pinned checkout is already cached. Purely local, no network. */
export function hasCheckout(evalsDir: string, manifest: ExternalManifest): boolean {
  const dir = checkoutDir(evalsDir, manifest)
  if (!fs.existsSync(path.join(dir, '.git'))) return false
  try {
    return headOf(dir) === manifest.commit
  } catch {
    return false
  }
}

/**
 * Return the pinned checkout, cloning it first when absent.
 *
 * Cloning is the only network access in the whole harness, and it is only
 * reached when `run.ts` has already decided this fixture may run (cache
 * present, or explicitly selected with `--fixture`).
 */
export function ensureCheckout(evalsDir: string, manifest: ExternalManifest): string {
  const dir = checkoutDir(evalsDir, manifest)

  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    console.log(`fetching ${manifest.repository} at ${manifest.commit} into evals/.cache/repos/`)
    execFileSync('git', ['clone', '--filter=blob:none', manifest.repository, dir], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    execFileSync('git', ['-C', dir, 'checkout', '--detach', manifest.commit], {
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }

  // The pin is verified on every use, cached or fresh. Scoring the wrong
  // commit would silently invalidate the fixture's entire ground truth.
  const head = headOf(dir)
  if (head !== manifest.commit) {
    throw new Error(
      `cached checkout ${dir} is at ${head}, not the pinned ${manifest.commit}; ` +
        'delete the directory and rerun to refetch',
    )
  }
  return dir
}

function headOf(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

export interface AssembleOptions {
  evalsDir: string
  /** Work directory name under `evals/.cache/work/`, one per fixture variant. */
  name: string
  /** The pristine pinned checkout (never written to). */
  checkout: string
  /** Directory holding the authored overlay; its listed entries are copied in. */
  overlayDir: string
  /** Overlay entries (files or directories) relative to `overlayDir`. */
  overlay: string[]
  /** Patch files to apply with `git apply`, in order. */
  patches?: string[]
}

/**
 * Assemble a fresh working directory: pinned sources, then overlay, then
 * patches. Rebuilt from scratch on every run so no stale state survives.
 */
export function assembleWorkdir(options: AssembleOptions): string {
  const work = path.join(options.evalsDir, '.cache', 'work', options.name)
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })

  fs.cpSync(options.checkout, work, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source)
      return base !== '.git' && base !== 'node_modules'
    },
  })

  for (const entry of options.overlay) {
    fs.cpSync(path.join(options.overlayDir, entry), path.join(work, entry), { recursive: true })
  }

  // `git apply` resolves paths against the enclosing repository, and this
  // work directory sits inside ours, so a patch would be skipped silently.
  // A throwaway `git init` pins the resolution root to the work directory
  // and makes a non-applying patch a hard error; the marker is removed again
  // so the assembled tree stays plain files.
  const patches = options.patches ?? []
  if (patches.length > 0) {
    execFileSync('git', ['init', '--quiet'], { cwd: work, stdio: 'ignore' })
    try {
      for (const patch of patches) {
        execFileSync('git', ['apply', patch], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
      }
    } finally {
      fs.rmSync(path.join(work, '.git'), { recursive: true, force: true })
    }
  }

  return work
}
