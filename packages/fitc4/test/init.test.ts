/**
 * `init` is judged by its promise: a scaffolded project's very first check
 * run is green, and nothing that already exists is ever overwritten.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { loadConfig, resolveConfig } from '../src/config.ts'
import { pipelineConfig } from '../src/defaults.ts'
import { AGENT_CONFIG_FILENAME, init, MODEL_PLACEHOLDER_MARKER } from '../src/init.ts'
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

describe('init', () => {
  test('scaffolds a config the loader accepts and a model, and names the gaps', () => {
    const root = scratch()

    const result = init(root)

    expect(result.created).toEqual(['fitc4.config.json', 'arch/model.c4', 'AGENTS.md'])
    expect(result.skipped).toEqual([])
    // A fresh directory has neither prerequisite; both are notes, not files —
    // guessing a project's TypeScript setup wrong is worse than asking.
    expect(result.notes.join('\n')).toContain('tsconfig.json')
    expect(result.notes.join('\n')).toContain('src/')
    // Agent setup ships as copy-paste commands, not prose.
    expect(result.notes.join('\n')).toContain(
      'mkdir -p .claude/skills && cp -R node_modules/fitc4/skills/fitc4 .claude/skills/fitc4',
    )
    expect(result.notes.join('\n')).toContain('claude mcp add likec4 -- npx likec4 mcp --stdio')

    const config = loadConfig(path.join(root, 'fitc4.config.json'))
    expect(config.scanRoots).toEqual(['src'])
    expect(config.modelDir).toBe(path.join(root, 'arch'))
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

    const result = await runPipeline(
      pipelineConfig(loadConfig(path.join(root, 'fitc4.config.json'))),
    )

    expect(result.modelErrors).toEqual([])
    expect(result.findings).toEqual([])
  })

  test('refuses to run where any config form already exists', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'fitc4.config.ts'), 'export default {}\n')

    expect(() => init(root)).toThrow(/already configured: fitc4\.config\.ts/)
    expect(fs.existsSync(path.join(root, 'fitc4.config.json'))).toBe(false)
  })

  test('keeps an existing model file untouched', () => {
    const root = scratch()
    fs.mkdirSync(path.join(root, 'arch'))
    fs.writeFileSync(path.join(root, 'arch', 'model.c4'), '// authored\n')

    const result = init(root)

    expect(result.created).toEqual(['fitc4.config.json', 'AGENTS.md'])
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
    expect(content).toContain('node_modules/fitc4/README.md#rules')
    // And the setup commands an agent arriving after init can run itself.
    expect(content).toContain(
      'mkdir -p .claude/skills && cp -R node_modules/fitc4/skills/fitc4 .claude/skills/fitc4',
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

describe('init --agent', () => {
  test('scaffolds a module config wired to the claude CLI, everything else identical', () => {
    const root = scratch()

    const result = init(root, { agent: 'claude' })

    // The .mts replaces the JSON config; model and AGENTS.md are unchanged.
    expect(result.created).toEqual([AGENT_CONFIG_FILENAME, 'arch/model.c4', 'AGENTS.md'])
    expect(fs.existsSync(path.join(root, 'fitc4.config.json'))).toBe(false)

    const config = fs.readFileSync(path.join(root, AGENT_CONFIG_FILENAME), 'utf8')
    // The measured-perfect model, one shared exec, declared as the agent.
    expect(config).toContain(`const exec = cached(claudeCli({ model: 'sonnet' }))`)
    expect(config).toContain('agent: exec,')
    // The gate providers ship commented out: composing them would make every
    // plain `fitc4` run bill a live call and fail in CI without a login.
    expect(config).not.toMatch(/^\s{2}resolve:/m)
    expect(config).not.toMatch(/^\s{2}validate:/m)
    expect(config).toContain('// resolve: [...defaultResolve, agentResolve({ exec })]')
    expect(config).toContain('// validate: [...defaultValidate, agentSemanticReview({ exec })]')
    expect(config).toContain('bills per run')
    expect(config).toContain('--config')
    // agentScan ships commented out too: a fail-closed scanner with
    // placeholder instructions would be worse than none.
    expect(config).not.toMatch(/^\s{2}scan:/m)
    expect(config).toContain('// scan: [')
    expect(config).toContain('write yours before enabling this')

    // The agent path says what changed: a module config, draft --describe, and
    // the caveat on the providers it deliberately did not compose.
    expect(result.notes.join('\n')).toContain('module config')
    expect(result.notes.join('\n')).toContain('fitc4 draft --describe')
    expect(result.notes.join('\n')).toContain('commented out')
  })

  test('scaffolds the codex CLI around its measured model', () => {
    const root = scratch()
    init(root, { agent: 'codex' })

    const config = fs.readFileSync(path.join(root, AGENT_CONFIG_FILENAME), 'utf8')
    expect(config).toContain(`const exec = cached(codexCli({ model: 'gpt-5.6-luna' }))`)
    expect(config).toContain('// resolve: [...defaultResolve, agentResolve({ exec })]')
    expect(config).toContain('call your codex CLI')
  })

  // The template is a working config, not pseudocode: rewrite its package
  // specifiers to the real entry modules and load it through the same
  // resolveConfig the CLI uses. A named import the entry points do not export
  // fails right here, at module link time.
  test.each(['claude', 'codex'] as const)(
    'the scaffolded %s template loads through resolveConfig',
    async (agent) => {
      const root = scratch()
      init(root, { agent })

      const configPath = path.join(root, AGENT_CONFIG_FILENAME)
      const template = fs.readFileSync(configPath, 'utf8')
      expect(template).toContain(`from 'fitc4'`)
      expect(template).toContain(`from 'fitc4/agent'`)

      const indexUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'index.ts')).href
      const agentUrl = pathToFileURL(
        path.join(import.meta.dirname, '..', 'src', 'agent', 'index.ts'),
      ).href
      fs.writeFileSync(
        configPath,
        template.replace(`from 'fitc4/agent'`, `from '${agentUrl}'`).replace(`from 'fitc4'`, `from '${indexUrl}'`),
      )

      const resolved = await resolveConfig(configPath)
      expect(resolved.agent?.id).toBe(agent === 'claude' ? 'claude-cli/sonnet' : 'codex-cli/gpt-5.6-luna')
      // The exec is declared and no phase is: every phase falls back to the
      // deterministic defaults, so the plain gate makes zero live calls.
      expect(resolved.providers).toBeUndefined()
      expect(pipelineConfig(resolved).validate.map((provider) => provider.id)).toEqual([
        'architecture-rules',
      ])
      expect(pipelineConfig(resolved).resolve.map((provider) => provider.id)).toEqual([
        'source-root',
      ])
      expect(resolved.scanRoots).toEqual(['src'])
    },
  )

  test('never overwrites: any existing config form still blocks init --agent', () => {
    const root = scratch()
    fs.writeFileSync(path.join(root, 'fitc4.config.json'), '{}\n')

    expect(() => init(root, { agent: 'claude' })).toThrow(/already configured/)
    expect(fs.existsSync(path.join(root, AGENT_CONFIG_FILENAME))).toBe(false)
  })

  test('a scaffolded .mts blocks a later plain init the same way', () => {
    const root = scratch()
    init(root, { agent: 'codex' })

    expect(() => init(root)).toThrow(/already configured: fitc4\.config\.mts/)
  })
})
