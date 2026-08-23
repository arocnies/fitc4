# fitc4-dependency-cruiser

[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) as a [FitC4](https://github.com/arocnies/fitc4) scan provider.

FitC4's built-in scanner reads TypeScript sources with the TypeScript compiler API. This package covers what that scanner cannot. Plain JavaScript, CommonJS, ESM, mixed projects: anything dependency-cruiser can cruise. The division of labor stays the same: **dependency-cruiser observes, the LikeC4 model judges.** The adapter emits observations only; the standard resolve and validate providers turn them into findings, without knowing which scanner ran.

Use the built-in `typescriptImports` scanner for pure-TypeScript projects (it has line-level evidence and tsconfig-alias awareness built in). Reach for this package when the code under architecture control is JavaScript, or a JS/TS mix.

This package is versioned and published separately from `fitc4` (it declares `fitc4` as a peer dependency).

## Install

```sh
npm i -D fitc4 fitc4-dependency-cruiser
```

## Usage

A complete `fitc4.config.ts`:

```ts
import { architectureRules, defineConfig, sourceRoot } from 'fitc4'
import { dependencyCruiser } from 'fitc4-dependency-cruiser'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [
    dependencyCruiser({
      roots: ['src'],
      // Optional pass-throughs, when the host project resolves through them:
      // tsconfigPath: 'tsconfig.json',       // paths/baseUrl aliases
      // webpackConfigPath: 'webpack.config.js', // resolve.alias etc.
    }),
  ],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
})
```

`dependencyCruiser(options)` returns a `NamedProvider<ScanProvider>` with id `dependency-cruiser`, so it composes anywhere a scan provider does, whether that is a config file or a direct `runPipeline` call. It uses dependency-cruiser's programmatic `cruise()` API; nothing shells out.

Options:

| Option | Default | Meaning |
|---|---|---|
| `roots` | `['.']` (the whole scan context) | Repository-relative directories to cruise. These bound what is under architecture control. |
| `tsconfigPath` | none | tsconfig whose `paths`/`baseUrl` apply during resolution (requires `typescript` installed). |
| `webpackConfigPath` | none | webpack config whose `resolve` options apply (requires `webpack` installed). |

## Observation mapping

| dependency-cruiser | FitC4 observation | Notes |
|---|---|---|
| a cruised module in this repository | `file` | `subject` is a `file` ref with the repository-relative POSIX path; id `file:<path>` |
| a resolved dependency on repository code | `dependency` | `target` is a `file` ref; `data.external: false`; id `dependency:<from>-><specifier>` |
| a resolved dependency on a Node builtin or an installed package | `dependency` | `target` is a `module` ref holding the specifier as written (`node:path`, `semver`); `data.external: true` |
| an unresolvable specifier that is demonstrably not our code (builtin, or declared in a `package.json` between the file and the repository root) | `dependency` | `data.external: true`, `data.resolved: false` |
| any other unresolvable specifier | `unresolved-dependency` | a broken relative path, a broken alias, or a phantom package must not silently drop out of the check |
| each cruised root | `scan-root` | the coverage attestation; `data.files` counts the modules the cruise covered under that root |

`data` carries `specifier`, `dependencyKind` (`import`, `require`, `dynamic-import`), `external`, and `resolved`, the same keys the built-in scanner emits.

## Fail closed

Anything that would make an empty result indistinguishable from a clean run throws instead, which the FitC4 core reports as a `provider-failure` finding:

- no roots configured,
- a root that is not a directory,
- a root that exists but yields no modules,
- any `cruise()` failure, including an unreadable tsconfig or webpack config.

## Differences from the built-in scanner

- **No line numbers.** dependency-cruiser reports module-level edges, so dependency ids are `dependency:<from>-><specifier>` (no `:line` component) and evidence has no `line`.
- **Repeated references collapse.** dependency-cruiser reports one edge per specifier per file; the built-in scanner records each occurrence with its own line.
- **Coverage can exceed the roots.** The roots are enumerated on disk, but modules outside them that the cruise reaches through imports are observed too; the built-in scanner observes only files under the roots.
- **Test files are excluded the same way.** The filename and directory conventions also cover the JavaScript extensions (`*.test.js`, `__tests__/`, ...). A test crossing a boundary is a testing decision, not a declared architectural dependency.
