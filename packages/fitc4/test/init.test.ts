/**
 * `init` is judged by its promise: a scaffolded project's very first check
 * run is green, and nothing that already exists is ever overwritten.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { CONFIG_FILENAME, resolveConfig, type ResolvedConfig } from '../src/config.ts'
import { init, MODEL_PLACEHOLDER_MARKER } from '../src/init.ts'
import { runPipeline } from '../src/pipeline.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-init-'))
  roots.push(root)
  return root
}

/**
 * Load a scaffolded config through the same resolveConfig the CLI uses.
 *
 * The template imports the package by name, which cannot resolve from a
 * scratch directory outside any node_modules, so the specifiers are rewritten
 * to the real entry modules first. A named import the entry points do not
 * export still fails right here, at module link time.
 */
async function resolveScaffolded(root: string): Promise<ResolvedConfig> {
  const configPath = path.join(root, CONFIG_FILENAME)
  const template = fs.readFileSync(configPath, 'utf8')
  const indexUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'index.ts')).href
  const agentUrl = pathToFileURL(
    path.join(import.meta.dirname, '..', 'src', 'agent', 'index.ts'),
  ).href
  fs.writeFileSync(
    configPath,
    template.replace(`from '@arocnies/fitc4/agent'`, `from '${agentUrl}'`).replace(`from '@arocnies/fitc4'`, `from '${indexUrl}'`),
  )
  return resolveConfig(configPath)
}

describe('init', () => {
  test('scaffolds a config the loader accepts and a model, and names the gaps', async () => {
    const root = scratch()

    const result = init(root)

    expect(result.created).toEqual([CONFIG_FILENAME, 'arch/model.c4', 'AGENTS.md'])
    expect(result.skipped).toEqual([])
    // A fresh directory has neither prerequisite; both are notes, not files —
    // guessing a project's TypeScript setup wrong is worse than asking.
    expect(result.notes.join('\n')).toContain('tsconfig.json')
    expect(result.notes.join('\n')).toContain('src/')
    // Agent setup ships as copy-paste commands, not prose.
    expect(result.notes.join('\n')).toContain(
      'mkdir -p .claude/skills && cp -R node_modules/@arocnies/fitc4/skills/fitc4 .claude/skills/fitc4',
    )
    expect(result.notes.join('\n')).toContain('claude mcp add likec4 -- npx likec4 mcp --stdio')

    const config = await resolveScaffolded(root)
    expect(config.modelDir).toBe(path.join(root, 'arch'))
    // The phases are written out in full and the scaffold names exactly the
    // standard gate — nothing extra, nothing composed in behind the file.
    expect(config.scan.map((provider) => provider.id)).toEqual(['typescript-imports'])
    expect(config.resolve.map((provider) => provider.id)).toEqual(['source-root'])
    expect(config.validate.map((provider) => provider.id)).toEqual(['architecture-rules'])
    expect(config.agent).toBeUndefined()
  })

  // The marker is what resolves the old contradiction, where init created the
  // file that made the draft it recommends refuse to write. It has to say both
  // halves: replaceable, and yours once you edit it.
  test('the starter model opens with the placeholder marker', () => {
    const root = scratch()
    init(root)

    const model = fs.readFileSync(path.join(root, 'arch', 'model.c4'), 'utf8')
    expect(model.split('\n')[0]).toBe(MODEL_PLACEHOLDER_MARKER)
    expect(MODEL_PLACEHOLDER_MARKER).toContain('may replace this file')
    expect(MODEL_PLACEHOLDER_MARKER).toContain('Edit it')
  })

  test('the first check run on a scaffolded project is green', async () => {
    const root = scratch()
    init(root)

    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const started = true\n')
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    )

    const result = await runPipeline(await resolveScaffolded(root))

    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
  })

  test('refuses to run where any config form already exists', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'fitc4.config.ts'), 'export default {}\n')

    expect(() => init(root)).toThrow(/already configured: fitc4\.config\.ts/)
    expect(fs.existsSync(path.join(root, CONFIG_FILENAME))).toBe(false)
  })

  test('a second init says the move: edit, or delete first', () => {
    const root = scratch()
    init(root)

    expect(() => init(root)).toThrow(/already configured: fitc4\.config\.mts/)
    expect(() => init(root)).toThrow(/Edit it, or delete it first to start over/)
    expect(() => init(root, { agent: 'codex' })).toThrow(/already configured/)
  })

  test('keeps an existing model file untouched', () => {
    const root = scratch()
    fs.mkdirSync(path.join(root, 'arch'))
    fs.writeFileSync(path.join(root, 'arch', 'model.c4'), '// authored\n')

    const result = init(root)

    expect(result.created).toEqual([CONFIG_FILENAME, 'AGENTS.md'])
    expect(result.skipped).toEqual(['arch/model.c4'])
    expect(fs.readFileSync(path.join(root, 'arch', 'model.c4'), 'utf8')).toBe('// authored\n')
  })

  test('the scaffolded AGENTS.md carries the fitc4 norms', () => {
    const root = scratch()
    init(root)

    const content = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
    // The one norm an agent cannot infer from the CLI: the model is the
    // contract, never edited merely to make a finding go away.
    expect(content).toContain('never merely to silence a finding')
    // Loosening the gate from the config is the same evasion, one layer up.
    expect(content).toContain("Never soften a rule's severity")
    expect(content).toContain('never remove a provider')
    expect(content).toContain('node_modules/@arocnies/fitc4/README.md#rules')
    // And the setup commands an agent arriving after init can run itself.
    expect(content).toContain(
      'mkdir -p .claude/skills && cp -R node_modules/@arocnies/fitc4/skills/fitc4 .claude/skills/fitc4',
    )
    expect(content).toContain('claude mcp add likec4 -- npx likec4 mcp --stdio')
  })

  test('keeps an existing AGENTS.md untouched and points at the README block', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# House rules\n')

    const result = init(root)

    expect(result.skipped).toContain('AGENTS.md')
    // The author merges the norms themselves — the note says where from.
    expect(result.notes.join('\n')).toContain('#for-ai-agents')
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# House rules\n')
  })
})

describe('the scaffolded config', () => {
  test('every line is live: explicit phases, no commented-out configuration', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    init(root, { agent: 'claude' })

    const config = fs.readFileSync(path.join(root, CONFIG_FILENAME), 'utf8')
    // The measured-perfect model, one shared exec, declared as the agent.
    expect(config).toContain(`const exec = cached(claudeCli({ model: 'sonnet' }))`)
    expect(config).toContain('agent: exec,')
    // Naming an agent CLI asked for it in the gate, so the agent providers
    // are composed live into the phases they extend, each with its cost
    // commented beside it. With a tsconfig present, agentScan stays out: the
    // deterministic scanner already observes the imports, and a second
    // scanner over them would cost a call per run for nothing.
    expect(config).toContain(
      `scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],`,
    )
    expect(config).not.toContain('agentScan({ exec })')
    expect(config).toContain('resolve: [sourceRoot(), agentResolve({ exec })],')
    expect(config).toContain('architectureRules(),')
    expect(config).toContain('agentOwnershipAdvisor({ exec }),')
    expect(config).toContain('agentSemanticReview({ exec }),')
    expect(config).toContain('README.md#agent-providers')

    // Nothing ships commented out. Thirty of fifty lines of switched-off
    // configuration made the first file a user opens read as a tutorial, and
    // commented code asks to be uncommented before it is understood.
    const commentedConfig = config
      .split('\n')
      .filter((line) => /^\s*\/\/\s*(resolve|validate|scan|agent):/.test(line))
    expect(commentedConfig).toEqual([])
    expect(config.split('\n').length).toBeLessThan(50)

    // The severity hint points at the provider, where the tuning now lives.
    // The composed provider ids are pinned by the template-load test below.
    expect(config).toContain(`severity: { 'unmapped-source': 'error' }`)
  })

  test('scaffolds the codex CLI around its measured model', () => {
    const root = scratch()
    const result = init(root, { agent: 'codex' })

    const config = fs.readFileSync(path.join(root, CONFIG_FILENAME), 'utf8')
    expect(config).toContain(`const exec = cached(codexCli({ model: 'gpt-5.6-luna' }))`)
    expect(config).toContain('calls your codex CLI')
    // The agent path says what changed: the exec, draft --describe, and the
    // cost of the fail-closed provider it composed into the gate.
    expect(result.notes.join('\n')).toContain("config's agent exec")
    expect(result.notes.join('\n')).toContain('fitc4 draft --describe')
    expect(result.notes.join('\n')).toContain('fail in CI without a login')
  })

  test('addresses its agent notes and AGENTS.md to the CLI that was chosen', () => {
    const codexRoot = scratch()
    const codexNotes = init(codexRoot, { agent: 'codex' }).notes.join('\n')
    const codexAgents = fs.readFileSync(path.join(codexRoot, 'AGENTS.md'), 'utf8')

    // The shipped skill is Claude Code's format, so a codex user is never
    // told to copy it, and the MCP command is codex's own.
    expect(codexNotes).toContain('codex mcp add likec4 -- npx likec4 mcp --stdio')
    expect(codexNotes).not.toContain('.claude/skills')
    expect(codexNotes).not.toContain('claude mcp add')
    expect(codexAgents).toContain('codex mcp add likec4')
    expect(codexAgents).not.toContain('.claude/skills')

    const claudeRoot = scratch()
    const claudeNotes = init(claudeRoot, { agent: 'claude' }).notes.join('\n')
    const claudeAgents = fs.readFileSync(path.join(claudeRoot, 'AGENTS.md'), 'utf8')
    expect(claudeNotes).toContain('.claude/skills')
    expect(claudeNotes).toContain('claude mcp add likec4')
    expect(claudeNotes).not.toContain('codex mcp add')
    expect(claudeAgents).toContain('.claude/skills')

    // With no agent named the reader is unknown, so both are listed.
    const plainRoot = scratch()
    init(plainRoot)
    const plainAgents = fs.readFileSync(path.join(plainRoot, 'AGENTS.md'), 'utf8')
    expect(plainAgents).toContain('.claude/skills')
    expect(plainAgents).toContain('codex mcp add likec4')
  })

  // The template is a working config, not pseudocode: a named import the
  // entry points do not export fails at module link time inside
  // resolveScaffolded. A bare directory has no tsconfig, so this is also the
  // any-language scaffold: agentScan carries the scan phase.
  test.each(['claude', 'codex'] as const)(
    'the scaffolded %s template loads through resolveConfig',
    async (agent) => {
      const root = scratch()
      init(root, { agent })

      const resolved = await resolveScaffolded(root)
      expect(resolved.agent?.id).toBe(
        agent === 'claude' ? 'claude-cli/sonnet' : 'codex-cli/gpt-5.6-luna',
      )
      // Naming an agent CLI composes the agent providers into the phases.
      expect(resolved.scan.map((provider) => provider.id)).toEqual(['agent-scan'])
      expect(resolved.resolve.map((provider) => provider.id)).toEqual(['source-root', 'agent-resolve'])
      expect(resolved.validate.map((provider) => provider.id)).toEqual([
        'architecture-rules',
        'agent-ownership-advisor',
        'agent-semantic-review',
      ])
    },
  )

  test('with a tsconfig the agent scaffold keeps the deterministic scanner', async () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
    init(root, { agent: 'claude' })

    const resolved = await resolveScaffolded(root)
    expect(resolved.scan.map((provider) => provider.id)).toEqual(['typescript-imports'])
  })

  test('without a tsconfig the agent scaffold scans with the agent, and says so', () => {
    const root = scratch()
    const result = init(root, { agent: 'claude' })

    const config = fs.readFileSync(path.join(root, CONFIG_FILENAME), 'utf8')
    expect(config).toContain('scan: [agentScan({ exec })],')
    expect(config).not.toContain('typescriptImports')
    // The note names the swap and the default behind it.
    expect(result.notes.join('\n')).toContain('the scan phase is agentScan')
    expect(result.notes.join('\n')).toContain('general import scan')
    // agentScan lists from the repository root, so the roots: ['src'] note
    // belongs to the TypeScript scaffold only.
    expect(result.notes.join('\n')).not.toContain("roots are ['src']")
  })

  test('never overwrites: any existing config form still blocks init --agent', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'fitc4.config.js'), 'export default {}\n')

    expect(() => init(root, { agent: 'claude' })).toThrow(/already configured/)
    expect(fs.existsSync(path.join(root, CONFIG_FILENAME))).toBe(false)
  })
})
