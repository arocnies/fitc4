/**
 * `fitc4 init` — scaffold a project into a first green run.
 *
 * Drops the two files a project needs: a `fitc4.config.json` and a starter
 * `arch/model.c4` whose single element owns `src/**`, so the very first
 * `npx fitc4` is green rather than a wall of unowned files. The starter is a
 * placeholder to split, not a suggestion of shape.
 *
 * Never overwrites: an existing config is an error (running init twice is a
 * mistake worth stopping), an existing model file is kept with a note (the
 * model is authored documentation, not this tool's property). Prerequisites
 * that cannot be scaffolded — a tsconfig, a source tree — become notes rather
 * than created files, because guessing a project's TypeScript setup wrong is
 * worse than asking.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIRECTORY, CONFIG_FILENAME, CONFIG_FILENAMES } from './config.ts'

export interface InitResult {
  /** Paths created, relative to the target directory. */
  created: string[]
  /** Paths that already existed and were left alone. */
  skipped: string[]
  /** Prerequisites the author still owns. */
  notes: string[]
}

export const MODEL_DIR = 'arch'
export const MODEL_FILENAME = 'model.c4'

const CONFIG_TEMPLATE = `{
  "$schema": "./node_modules/fitc4/schema/fitc4.config.schema.json",
  "version": 1,
  "repositoryRoot": ".",
  "model": "${MODEL_DIR}",
  "scanRoots": ["src"],
  "tsconfig": "tsconfig.json"
}
`

const MODEL_TEMPLATE = `specification {
  element system
  element component
}

model {
  app = system 'App' {
    core = component 'Core' {
      description 'TODO: what is this component responsible for?'
      metadata {
        sources 'src/**'
      }
    }
  }
}

views {
  view index of app {
    include *
  }
}
`

export function init(directory: string): InitResult {
  const target = path.resolve(directory)

  // Only this directory blocks init — an ancestor's config governs a parent
  // project, and initializing a nested one under it is legitimate.
  for (const location of [target, path.join(target, CONFIG_DIRECTORY)]) {
    for (const name of CONFIG_FILENAMES) {
      const existing = path.join(location, name)
      if (fs.existsSync(existing)) {
        throw new Error(
          `already configured: ${path.relative(target, existing) || name} exists. ` +
            `Edit it, or delete it first to start over.`,
        )
      }
    }
  }

  const result: InitResult = { created: [], skipped: [], notes: [] }

  fs.writeFileSync(path.join(target, CONFIG_FILENAME), CONFIG_TEMPLATE)
  result.created.push(CONFIG_FILENAME)

  const modelPath = path.join(target, MODEL_DIR, MODEL_FILENAME)
  const modelRelative = `${MODEL_DIR}/${MODEL_FILENAME}`
  if (fs.existsSync(modelPath)) {
    result.skipped.push(modelRelative)
  } else {
    fs.mkdirSync(path.dirname(modelPath), { recursive: true })
    fs.writeFileSync(modelPath, MODEL_TEMPLATE)
    result.created.push(modelRelative)
  }

  if (!fs.existsSync(path.join(target, 'tsconfig.json'))) {
    result.notes.push(
      `no tsconfig.json here — create one, or point the config's 'tsconfig' at your real one`,
    )
  }
  if (!fs.existsSync(path.join(target, 'src'))) {
    result.notes.push(`scanRoots is ["src"] but src/ does not exist — create it or edit scanRoots`)
  }

  return result
}
