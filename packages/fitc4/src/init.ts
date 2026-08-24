/**
 * `fitc4 init`: set a project up for a first green run.
 *
 * Drops the files a project needs: a `fitc4.config.mts` naming the standard
 * phases explicitly, a starter `arch/model.c4` whose single element owns
 * `src/**`, so the very first `npx fitc4` is green rather than a wall of
 * unowned files, and an `AGENTS.md` carrying the one norm a coding agent
 * cannot infer from the CLI: the model is the contract, not a knob for
 * silencing findings. The starter model is a placeholder to split, not a
 * suggestion of shape, and it says so in its first line: see
 * `MODEL_PLACEHOLDER_MARKER`.
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
   * Also declare this agent CLI as the config's `agent` exec, so
   * `fitc4 draft --describe` works immediately, and compose the agent
   * providers into the scaffolded phases. Everything else init does is
   * identical.
   */
  agent?: InitAgent
}

export const MODEL_DIR = 'arch'
export const MODEL_FILENAME = 'model.c4'
export const AGENTS_FILENAME = 'AGENTS.md'

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
 * The config `init` scaffolds. Every line is live configuration, and the
 * phases are written out in full with a comment saying what each one does:
 * what runs is what the file names, so reading the config is reading the
 * gate. This becomes the user's file to own, so it carries their settings,
 * never a tutorial.
 *
 * With `--agent`, the agent providers join the phases they extend: a user
 * who named an agent CLI asked for it in the gate, and a scaffold that only
 * hints at the providers makes them look optional extras rather than the
 * point of the flag. The costs live in the comments beside each provider.
 * agentResolve is fail-closed, so every run calls the CLI and a run without
 * a login fails; the two validate providers are advisory and degrade to a
 * visible agent-unavailable finding. agentScan alone is not scaffolded: it
 * is fail-closed and needs the user's own instructions, and a scanner driven
 * by placeholder prose is worse than no scanner.
 */
function configTemplate(agent: InitAgent | undefined): string {
  if (agent === undefined) {
    return `import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'

export default defineConfig({
  version: 1,
  // Paths in this file resolve relative to the file itself.
  repositoryRoot: '.',
  // The directory holding the LikeC4 model, the contract the code is checked against.
  model: '${MODEL_DIR}',

  // The phases are explicit: what runs is what this file names.
  // Scan observes the code: every file and every import under roots.
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  // Resolve maps each observation onto the element whose 'sources' claims it.
  resolve: [sourceRoot()],
  // Validate judges the mapped code against the declared architecture. Tune a
  // rule here, such as
  // architectureRules({ severity: { 'unmapped-source': 'error' } })
  // once you are done adopting: node_modules/@arocnies/fitc4/README.md#rules
  validate: [architectureRules()],
})
`
  }

  return `import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'
import {
  agentOwnershipAdvisor,
  agentResolve,
  agentSemanticReview,
  ${AGENT_EXEC_IMPORTS[agent].replace(', ', ',\n  ')},
} from '@arocnies/fitc4/agent'

// Your own ${agent} CLI, on your own login and billing. cached() makes reruns
// with unchanged inputs free. This model measured perfect in the fitc4 evals.
${AGENT_EXEC_LINES[agent]}

export default defineConfig({
  version: 1,
  // Paths in this file resolve relative to the file itself.
  repositoryRoot: '.',
  // The directory holding the LikeC4 model, the contract the code is checked against.
  model: '${MODEL_DIR}',

  // The phases are explicit: what runs is what this file names.
  // Scan observes the code: every file and every import under roots. agentScan
  // can join it for domains no parser covers, once you write its instructions:
  // node_modules/@arocnies/fitc4/README.md#agent-providers
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  // Resolve maps observations onto the model. sourceRoot() maps files through
  // 'sources' claims; agentResolve maps what that cannot, such as imports of
  // external packages onto elements that own no files. It is fail-closed:
  // every fitc4 run calls your ${agent} CLI, and a run without a login fails.
  resolve: [sourceRoot(), agentResolve({ exec })],
  validate: [
    // The gate. Tune a rule here, such as
    // architectureRules({ severity: { 'unmapped-source': 'error' } })
    architectureRules(),
    // Advisory, so without a logged-in CLI these two degrade to a visible
    // agent-unavailable finding instead of failing the run.
    // Suggests an owner for any file no element claims. No calls when clean.
    agentOwnershipAdvisor({ exec }),
    // Reviews each described element's implementation against its
    // description, one call per described element.
    agentSemanticReview({ exec }),
  ],
  // Commands also use the exec directly: fitc4 draft --describe proposes each
  // drafted element's description with it.
  agent: exec,
})
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

const SKILL_INSTALL = `mkdir -p .claude/skills && cp -R node_modules/@arocnies/fitc4/skills/fitc4 .claude/skills/fitc4`

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
- Never soften a rule's severity in the config, and never remove a provider
  from a phase, to make a finding go away. How strict the gate is belongs to
  the team; loosening it for a green run is the same evasion as deleting the
  relationship, one layer up.
- Rule reference: \`node_modules/@arocnies/fitc4/README.md#rules\`. Structured output:
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
        throw new Error(
          `already configured: ${found} exists. Edit it, or delete it first to start over.`,
        )
      }
    }
  }

  const result: InitResult = { created: [], skipped: [], notes: [] }

  fs.writeFileSync(path.join(target, CONFIG_FILENAME), configTemplate(options.agent))
  result.created.push(CONFIG_FILENAME)
  if (options.agent !== undefined) {
    result.notes.push(
      `${CONFIG_FILENAME} declares the ${options.agent} CLI as the config's agent exec, ` +
        `so fitc4 draft --describe works immediately, and composes the agent providers ` +
        `into the gate. agentResolve is fail-closed: every fitc4 run calls your CLI and ` +
        `will fail in CI without a login. Each provider's cost is commented beside it; ` +
        `remove the ones your CI cannot carry`,
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
        `the copy-paste block is at node_modules/@arocnies/fitc4/README.md#for-ai-agents`,
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
    result.notes.push(`the scaffolded scan roots are ['src'] but src/ does not exist. Create it or edit 'roots'`)
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
