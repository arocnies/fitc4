/**
 * `fitc4 init`: set a project up for a first green run.
 *
 * Drops the files a project needs: a `fitc4.config.json`, a starter
 * `arch/model.c4` whose single element owns `src/**`, so the very first
 * `npx fitc4` is green rather than a wall of unowned files, and an
 * `AGENTS.md` carrying the one norm a coding agent cannot infer from the CLI:
 * the model is the contract, not a knob for silencing findings. The starter
 * model is a placeholder to split, not a suggestion of shape, and it says so
 * in its first line: see `MODEL_PLACEHOLDER_MARKER`.
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

/** The agent CLIs `init --agent` can scaffold a config around. */
export const INIT_AGENTS = ['claude', 'codex'] as const
export type InitAgent = (typeof INIT_AGENTS)[number]

export interface InitOptions {
  /**
   * Scaffold a `fitc4.config.mts` module config wired to this agent CLI
   * instead of the JSON config. `.mts` on purpose: it loads as an ES module in
   * ESM and CommonJS packages alike (see `CONFIG_FILENAMES` in config.ts).
   * Everything else init does is identical.
   */
  agent?: InitAgent
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

export const AGENT_CONFIG_FILENAME = 'fitc4.config.mts'

/** The exec line per agent CLI. Both models measured perfect in the evals. */
const AGENT_EXEC_LINES: Record<InitAgent, string> = {
  claude: `const exec = cached(claudeCli({ model: 'sonnet' }))`,
  codex: `const exec = cached(codexCli({ model: 'gpt-5.6-luna' }))`,
}

const AGENT_EXEC_IMPORTS: Record<InitAgent, string> = {
  claude: 'cached, claudeCli',
  codex: 'cached, codexCli',
}

/**
 * The module config `init --agent` scaffolds: an exec declared once, and
 * nothing that spends money until a command asks for it.
 *
 * Every line here is live configuration. An earlier version shipped the agent
 * gate providers and an `agentScan` example commented out in place, thirty of
 * fifty lines, and the first file a new user opened had more configuration
 * switched off than on. Commented-out code reads as a decision the scaffold
 * already made for you and asks to be uncommented before it is understood.
 * The trade those blocks explained is real and still stated, once, as prose at
 * the bottom, with the README carrying the composition: enabling them makes
 * every plain `npx fitc4`, the command the scaffolded AGENTS.md tells every
 * coding agent to run before handoff, bill a live call on every machine, and
 * fail in CI where no CLI is logged in. A config that bills per gate run is a
 * config a team turns off, which is worse than one they graduate into.
 *
 * This becomes the user's file to own, so it carries their settings and the
 * reasons, never a tutorial.
 */
function agentConfigTemplate(agent: InitAgent): string {
  return `import { defineConfig } from 'fitc4'
import { ${AGENT_EXEC_IMPORTS[agent]} } from 'fitc4/agent'

// Your own ${agent} CLI, on your own login and billing. cached() makes reruns
// with unchanged inputs free. This model measured perfect in the fitc4 evals.
${AGENT_EXEC_LINES[agent]}

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: '${MODEL_DIR}',
  scanRoots: ['src'],
  tsconfig: 'tsconfig.json',

  // The exec commands use directly, such as fitc4 draft --describe. Declaring
  // it costs nothing: no call happens until a command asks for one.
  agent: exec,
})

// Rule severities are tunable from here too, without touching providers:
// severity: { 'unmapped-source': 'error' } once you are done adopting.
//
// Agent providers can also join the gate itself, judging each description
// against the code or claiming files no pattern owns. They are not wired in
// above because doing so makes every 'fitc4' run call your ${agent} CLI, which
// bills per run and fails in CI where nothing is logged in. The usual move is
// a second config, say fitc4.agent.config.mts, run with --config beside this
// one. Composition and caveats: node_modules/fitc4/README.md#agent-providers
`
}

/**
 * The first line of the starter model, and the one thing that lets `draft`
 * write into a model directory that already holds a model file.
 *
 * The never-overwrite rule protects authored documentation. An untouched
 * placeholder this tool wrote itself is not authored documentation, so
 * replacing it weakens nothing: it resolves the contradiction where `init`
 * created the very file that made the `draft` it recommends refuse to write.
 * The marker states both halves of the deal, because a user who edits this
 * file must be able to tell from the file alone that they now own it.
 *
 * One shared constant on purpose. Two copies of this string, one in the
 * template and one in draft's check, would drift into a placeholder no draft
 * ever recognizes, which is the silent return of the same contradiction.
 */
export const MODEL_PLACEHOLDER_MARKER =
  `// fitc4 init placeholder. 'fitc4 draft' may replace this file. ` +
  `Edit it and draft will leave it alone.`

const MODEL_TEMPLATE = `${MODEL_PLACEHOLDER_MARKER}
specification {
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

/**
 * The MCP registration command per agent CLI, verified against each CLI's own
 * `--help` rather than assumed to match the other's.
 */
const MCP_COMMANDS: Record<InitAgent, string> = {
  claude: 'claude mcp add likec4 -- npx likec4 mcp --stdio',
  codex: 'codex mcp add likec4 -- npx likec4 mcp --stdio',
}

const SKILL_INSTALL = `mkdir -p .claude/skills && cp -R node_modules/fitc4/skills/fitc4 .claude/skills/fitc4`

/**
 * The "Agent setup" half of AGENTS.md, addressed to whichever CLI was chosen.
 *
 * With `--agent`, the reader is known, so the file says the one thing that
 * applies to them. Without it, both are listed and labeled. The shipped skill
 * is Claude Code's format, so it is named only where it can be installed;
 * telling a codex user to copy a directory into `.claude/` was advice for
 * somebody else's tool, in a file their agent reads on every run.
 */
function agentSetupSection(agent: InitAgent | undefined): string {
  const mcpLine = (command: string): string =>
    `- To query the architecture model while you work, register the LikeC4 MCP\n  server: \`${command}\``

  if (agent === 'codex') {
    return `## Agent setup

- This file is what Codex reads. Keep the norms above in it.
${mcpLine(MCP_COMMANDS.codex)}
`
  }
  if (agent === 'claude') {
    return `## Agent setup

- The package ships a fitc4 skill for Claude Code. Install it with
  \`${SKILL_INSTALL}\`
${mcpLine(MCP_COMMANDS.claude)}
`
  }
  return `## Agent setup

- Claude Code: the package ships a fitc4 skill. Install it with
  \`${SKILL_INSTALL}\`
- To query the architecture model while you work, register the LikeC4 MCP
  server: \`${MCP_COMMANDS.claude}\` (Codex: \`${MCP_COMMANDS.codex}\`)
`
}

const AGENTS_NORMS = `# Agent instructions

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
- Never soften a rule in the config's \`severity\` map to make a finding go
  away. Promoting a rule is a team decision about how strict the gate is;
  demoting one to get a green run is the same evasion as deleting the
  relationship, one layer up.
- Rule reference: \`node_modules/fitc4/README.md#rules\`. Structured output:
  \`npx fitc4 --json\`.

`

export function init(directory: string, options: InitOptions = {}): InitResult {
  const target = path.resolve(directory)

  // Only this directory blocks init. An ancestor's config governs a parent
  // project, and initializing a nested one under it is legitimate.
  for (const location of [target, path.join(target, CONFIG_DIRECTORY)]) {
    for (const name of CONFIG_FILENAMES) {
      const existing = path.join(location, name)
      if (fs.existsSync(existing)) {
        const found = path.relative(target, existing) || name
        // "Edit it" is good advice for a second plain init and wrong advice
        // for --agent on a JSON config: an exec is a function, so there is
        // nothing to edit into JSON. Name the actual move instead. The other
        // files init writes already exist by then, so a re-init keeps them.
        if (options.agent !== undefined && found.endsWith('.json')) {
          throw new Error(
            `already configured: ${found} exists, and an agent exec cannot go in JSON. ` +
              `Delete ${found} and rerun this command: init keeps your existing ` +
              `${MODEL_DIR}/${MODEL_FILENAME} and ${AGENTS_FILENAME}, so only the config is ` +
              `replaced. Or write the ${AGENT_CONFIG_FILENAME} by hand ` +
              `(see node_modules/fitc4/README.md#agent-providers).`,
          )
        }
        throw new Error(
          `already configured: ${found} exists. Edit it, or delete it first to start over.`,
        )
      }
    }
  }

  const result: InitResult = { created: [], skipped: [], notes: [] }

  if (options.agent === undefined) {
    fs.writeFileSync(path.join(target, CONFIG_FILENAME), CONFIG_TEMPLATE)
    result.created.push(CONFIG_FILENAME)
  } else {
    fs.writeFileSync(path.join(target, AGENT_CONFIG_FILENAME), agentConfigTemplate(options.agent))
    result.created.push(AGENT_CONFIG_FILENAME)
    result.notes.push(
      `${AGENT_CONFIG_FILENAME} declares the ${options.agent} CLI as the config's agent exec, ` +
        `so fitc4 draft --describe works immediately. No agent provider joins the gate itself: ` +
        `that would call your CLI on every fitc4 run and fail in CI without a login. The ` +
        `bottom of the file says where to read about enabling them`,
    )
  }

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
    fs.writeFileSync(agentsPath, AGENTS_NORMS + agentSetupSection(options.agent))
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

  // Commands, not copied files: .claude/ and the MCP registry are the user's
  // to curate. Addressed to the agent that was named, if one was: telling a
  // codex user to copy a Claude Code skill is a note about somebody else's
  // tool, and two of the three notes being for the wrong CLI teaches a reader
  // to skim the third.
  if (options.agent !== 'codex') {
    result.notes.push(
      `${options.agent === 'claude' ? 'install' : 'Claude Code users: install'} ` +
        `the shipped fitc4 skill with ${SKILL_INSTALL}`,
    )
  }
  result.notes.push(
    `to let an agent query the architecture model while it works, register the ` +
      `LikeC4 MCP server: ${MCP_COMMANDS[options.agent ?? 'claude']}`,
  )

  return result
}
