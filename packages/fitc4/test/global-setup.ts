/**
 * The `monorepo` fixture needs `node_modules/@acme/lib` to be a symlink into
 * its own `packages/lib`, the way npm workspaces would lay it out. git ignores
 * `node_modules/`, so the link cannot be committed — a fresh clone or worktree
 * is missing it and two tests fail. Created here instead, on every test run.
 */

import fs from 'node:fs'
import path from 'node:path'

export default function setup(): void {
  const fixture = path.join(import.meta.dirname, 'fixtures', 'monorepo')
  const scope = path.join(fixture, 'node_modules', '@acme')
  const link = path.join(scope, 'lib')
  const target = path.join(fixture, 'packages', 'lib')

  // `existsSync` follows symlinks, so a link whose target moved — a renamed
  // package directory, say — reads as missing and recreation hits EEXIST.
  // Compare the link itself and heal anything stale.
  try {
    if (fs.readlinkSync(link) === target) return
  } catch {
    // Missing or not a symlink; either way, rebuild it.
  }
  fs.rmSync(link, { recursive: true, force: true })
  fs.mkdirSync(scope, { recursive: true })
  // 'junction' keeps this working on Windows without elevated privileges;
  // on POSIX it falls back to an ordinary directory symlink.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}
