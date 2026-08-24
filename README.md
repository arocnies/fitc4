# FitC4

[![CI](https://github.com/arocnies/fitc4/actions/workflows/ci.yml/badge.svg)](https://github.com/arocnies/fitc4/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 22.22.3](https://img.shields.io/badge/node-%3E%3D22.22.3-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

FitC4 turns a [LikeC4](https://likec4.dev) architecture model into a CI gate for the code that implements it.

A LikeC4 model says which elements exist, which files they own, and which dependencies are allowed. FitC4 scans the implementation, maps those observations onto model elements, and reports when the code and the architecture disagree. The model stays readable architecture documentation; FitC4 makes it enforceable.

## Quickstart

Requires Node.js `>=22.22.3` and a `tsconfig.json`. FitC4 runs during development and CI, so install it as a dev dependency; `-D` is the short form of `--save-dev`.

```sh
npm install --save-dev fitc4
npx fitc4 init
npx fitc4
```

If you use Claude Code or Codex, use the agent-aware scaffold instead of plain `init`:

```sh
npx fitc4 init --agent claude   # or: --agent codex
```

This configures the local agent CLI for FitC4's agent providers and draft descriptions. It uses that CLI's existing login and billing, so see [agent providers](packages/fitc4/README.md#agent-providers) before enabling it in CI.

`init` creates these files when they do not already exist (it never overwrites authored files):

- `fitc4.config.mts` — the config the CLI discovers and runs.
- `arch/model.c4` — a starter LikeC4 model whose `src/**` ownership can make the first run green once the required source tree and tsconfig are present.
- `AGENTS.md` — the architecture-gate rules for coding agents working in the repository.

The starter model is deliberately small. Split it into the components your system actually has, give each element a `sources` claim, and declare the relationships the code is allowed to use. Most projects add this script and run it in CI:

```json
{
  "scripts": {
    "fitc4": "fitc4"
  }
}
```

For an existing codebase, draft the first model from observed dependencies instead of writing every edge by hand:

```sh
npx fitc4 draft
# edit arch/model.c4: name the elements, write descriptions, and bless intended edges
npx fitc4
```

By default, every drafted relationship is tagged as tolerated drift, so adoption starts green while the report counts the debt down. See [tolerated drift](packages/fitc4/README.md#tolerated-drift) for the full workflow.

## The core idea

The model owns two decisions: who owns a file, and which direction a dependency may travel.

```text
core = component 'Core' {
  metadata {
    sources 'src/core/**'
  }
}

interface = component 'Interface' {
  metadata {
    sources 'src/interface/**'
  }
}

interface -> core 'uses'
```

An import from `src/interface/` to `src/core/` follows the contract. An import in the opposite direction produces a `relationship-direction` finding. A scanned file that no element claims produces an `unmapped-source` finding. Findings include a rule ID and evidence, and error-severity findings make the command exit non-zero.

The gate is intentionally fail-closed: malformed metadata, missing scan roots, provider failures, and observations no rule understands are findings rather than silent passes.

## How it works

The config names the phases explicitly. There are no hidden default providers, so the file tells you exactly what the gate runs.

| Phase | Question | Built-in provider |
| --- | --- | --- |
| `scan` | What files and imports exist? | `typescriptImports()` |
| `resolve` | Which model element owns each observation? | `sourceRoot()` |
| `validate` | Does the model allow the observed code? | `architectureRules()` |

The smallest useful config looks like this:

```ts
import { architectureRules, defineConfig, sourceRoot, typescriptImports } from 'fitc4'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
})
```

## Where it fits

| If you need to… | Start here |
| --- | --- |
| Check a TypeScript project | Use FitC4's built-in `typescriptImports()` scanner. |
| Adopt an existing codebase | Run `npx fitc4 draft`, then remove drift as the architecture improves. |
| Check JavaScript or mixed JS/TS | Add [`fitc4-dependency-cruiser`](packages/fitc4-dependency-cruiser/README.md). |
| Observe domains without a parser | Compose a custom provider, or prototype with [`fitc4/agent`](packages/fitc4/README.md#agent-providers). |
| Let coding agents work inside the contract | Run `npx fitc4 init --agent claude` or `npx fitc4 init --agent codex`; read [For AI agents](packages/fitc4/README.md#for-ai-agents). |

Providers are plain functions composed into the three phase arrays. A provider can observe anything the implementation exposes—imports, compose files, runbooks, OpenAPI specs—and the same resolve and validation pipeline judges its observations.

## Documentation

- [Package README](packages/fitc4/README.md) — full installation guide, configuration, rules, drift, agent providers, and library API.
- [Worked example](example/README.md) — a small project with boundary, ownership, and drift exercises.
- [Provider contract](docs/providers.md) — the observation, association, and finding envelopes for custom providers.
- [Agent provider reference](docs/agent-providers.md) — fail-closed scanning and advisory review providers.
- [JavaScript provider](packages/fitc4-dependency-cruiser/README.md) — dependency-cruiser integration for JS and mixed projects.
- [Design of record](docs/DESIGN.md) — the architecture and invariants behind the tool.

Findings can also link to a published LikeC4 viewer. Set `viewerBaseUrl` in the config after publishing a viewer with `likec4 build`; `--json` then includes links to the relevant model view.

## Development

```sh
npm install
npm run verify       # build, tests, model checks, and the self-hosted example
npm run smoke        # pack the real tarball and test it in a throwaway consumer
npm run view -w example
```

`npm run smoke` is the publish-shaped check: workspace links do not exercise the package `files` allowlist or the complete `exports` map, while the smoke test installs the actual tarball. Run it before publishing.

The repository is self-hosting. [`packages/fitc4/arch/model.c4`](packages/fitc4/arch/model.c4) models the package source, and CI runs the gate on Node 22 and 26. The supported CI environment is Linux; Windows is not currently exercised.

## Contributing

Issues and pull requests are welcome. Before opening one, run `npm run verify` and describe any change to the architecture model alongside the implementation change.

## License

[MIT](LICENSE)
