/**
 * `fitc4 init`: set a project up for a first green run.
 *
 * Drops the files a project needs: a `fitc4.config.json`, a starter
 * `arch/model.c4` whose single element owns `src/**`, so the very first
 * `npx fitc4` is green rather than a wall of unowned files, and an
 * `AGENTS.md` carrying the one norm a coding agent cannot infer from the CLI:
 * the model is the contract, not a knob for silencing findings. The starter
 * model is a placeholder to split, not a suggestion of shape.
 *
 * Never overwrites: an existing config is an error (running init twice is a
 * mistake worth stopping), an existing model file or AGENTS.md is kept with a
 * note (both are authored documentation, not this tool's property).
 * Prerequisites this command cannot create for you, a tsconfig or a source
 * tree, become notes rather than created files, because guessing a project's
 * TypeScript setup wrong is worse than asking.
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
export const AGENTS_FILENAME = 'AGENTS.md'

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

const AGENTS_TEMPLATE = `# Agent instructions

## Architecture gate (fitc4)

- Run \`npx fitc4\` before handing off changes; it checks the code against the
  LikeC4 architecture model. Exit 1 is an architecture violation, not a flaky
  tool.
- A finding means the code and the contract disagree. Fixing the code is the
  default. Editing the model is a design decision. It is legitimate when the
  architecture genuinely changed, never merely to silence a finding. Call out
  any model change explicitly when handing off.
- Never delete \`sources\` metadata or a declared relationship to make a finding
  go away. That removes code from architecture control entirely.
- Rule reference: \`node_modules/fitc4/README.md#rules\`. Structured output:
  \`npx fitc4 --json\`.

## Agent setup

- Claude Code: the package ships a fitc4 skill. Install it with
  \`mkdir -p .claude/skills && cp -R node_modules/fitc4/skills/fitc4 .claude/skills/fitc4\`
- To query the architecture model while you work, register the LikeC4 MCP
  server: \`claude mcp add likec4 -- npx likec4 mcp --stdio\`
`

export function init(directory: string): InitResult {
  const target = path.resolve(directory)

  // Only this directory blocks init. An ancestor's config governs a parent
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

  const agentsPath = path.join(target, AGENTS_FILENAME)
  if (fs.existsSync(agentsPath)) {
    result.skipped.push(AGENTS_FILENAME)
    result.notes.push(
      `AGENTS.md already exists. Merge the fitc4 norms into it yourself; ` +
        `the copy-paste block is at node_modules/fitc4/README.md#for-ai-agents`,
    )
  } else {
    fs.writeFileSync(agentsPath, AGENTS_TEMPLATE)
    result.created.push(AGENTS_FILENAME)
  }

  if (!fs.existsSync(path.join(target, 'tsconfig.json'))) {
    result.notes.push(
      `no tsconfig.json here. Create one, or point the config's 'tsconfig' at your real one`,
    )
  }
  if (!fs.existsSync(path.join(target, 'src'))) {
    result.notes.push(`scanRoots is ["src"] but src/ does not exist. Create it or edit scanRoots`)
  }

  // Commands, not copied files: .claude/ and the MCP registry are the user's to curate.
  result.notes.push(
    `Claude Code users: install the shipped fitc4 skill with ` +
      `mkdir -p .claude/skills && cp -R node_modules/fitc4/skills/fitc4 .claude/skills/fitc4`,
  )
  result.notes.push(
    `to let an agent query the architecture model while it works, register the ` +
      `LikeC4 MCP server: claude mcp add likec4 -- npx likec4 mcp --stdio`,
  )

  return result
}
