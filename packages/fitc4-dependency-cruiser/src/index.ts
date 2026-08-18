/**
 * The `dependency-cruiser` scan provider for FitC4.
 *
 * Adapts dependency-cruiser's programmatic `cruise()` API to the FitC4 scan
 * contract: modules become `file` observations, module references become
 * `dependency` / `unresolved-dependency` observations, and each cruised root
 * becomes a `scan-root` coverage attestation. The adapter observes
 * implementation facts only — dependency-cruiser sees the code, the LikeC4
 * model judges it — so it emits no findings and knows nothing about the model.
 *
 * The output mirrors the built-in `typescript-imports` scanner shape for
 * shape: repository-relative POSIX paths, the same observation kinds, the
 * same subject/target ref kinds, natural-key ids, and the same `external`
 * semantics — so the standard resolve and validate providers read this
 * scanner's output without knowing which scanner ran.
 */

import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { cruise } from 'dependency-cruiser'
import type {
  ICruiseOptions,
  ICruiseResult,
  IDependency,
  IModule,
  IResolveOptions,
  ITranspileOptions,
} from 'dependency-cruiser'
import type { NamedProvider, Observation, ScanContext, ScanProvider } from 'fitc4'

export const PROVIDER_ID = 'dependency-cruiser'

export interface DependencyCruiserOptions {
  /**
   * Repository-relative directories to cruise.
   *
   * Defaults to the whole scan context — the repository root. These bound
   * what is under architecture control; they are deliberately not derived
   * from the model, because a file can only be reported as unowned if the
   * scanner looked at it in the first place.
   */
  roots?: string[]
  /**
   * Repository-relative path to a tsconfig whose `paths` / `baseUrl` should
   * apply during resolution. Requires `typescript` to be installed in the
   * host project (dependency-cruiser loads it to parse the file).
   */
  tsconfigPath?: string
  /**
   * Repository-relative path to a webpack config whose `resolve` options
   * should apply during resolution. Requires `webpack` to be installed in
   * the host project.
   */
  webpackConfigPath?: string
}

/** dependency-cruiser as a FitC4 scan provider. */
export function dependencyCruiser(
  options: DependencyCruiserOptions = {},
): NamedProvider<ScanProvider> {
  return { id: PROVIDER_ID, run: run(options) }
}

function run(options: DependencyCruiserOptions): ScanProvider {
  return async (context: ScanContext): Promise<Observation[]> => {
    const roots = options.roots ?? ['.']

    // A scan with no roots observes nothing, every violation disappears, and
    // the run goes green — the exact fail-open this tool exists to prevent.
    if (roots.length === 0) {
      throw new Error('no scan roots configured; there is nothing under architecture control')
    }

    const repositoryRoot = path.resolve(context.repositoryRoot)
    const rootPrefixes = new Map<string, string>()

    for (const root of roots) {
      const absolute = path.resolve(repositoryRoot, root)
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
        throw new Error(`scan root '${root}' is not a directory`)
      }
      rootPrefixes.set(root, toPosix(path.relative(repositoryRoot, absolute)))
    }

    const tsconfig = await parsedTsconfig(repositoryRoot, options.tsconfigPath)
    const modules = internalModules(
      await cruiseRepository(repositoryRoot, roots, options, tsconfig),
    )
    const declaredPackages = declaredPackageLookup(repositoryRoot)
    const tsconfigPaths = Object.keys(tsconfig?.options?.paths ?? {})
    const observations: Observation[] = []

    for (const root of roots) {
      const prefix = rootPrefixes.get(root) ?? root
      const covered = modules.filter((module) => isUnder(module.source, prefix))

      // dependency-cruiser returns an empty module list for a root with
      // nothing it can parse — indistinguishable from a clean run, so it
      // fails loudly instead, mirroring the built-in scanner.
      if (covered.length === 0) {
        throw new Error(`scan root '${root}' contains no modules`)
      }

      observations.push({
        id: `scan-root:${root}`,
        kind: 'scan-root',
        subject: { kind: 'directory', id: prefix === '' ? '.' : prefix },
        description: `${root} is under architecture control`,
        data: { files: covered.length },
        provider: PROVIDER_ID,
      })
    }

    for (const module of [...modules].sort(bySource)) {
      const from = module.source
      if (isTestPath(from)) continue

      observations.push({
        id: `file:${from}`,
        kind: 'file',
        subject: { kind: 'file', id: from },
        evidence: [{ path: from }],
        provider: PROVIDER_ID,
      })

      // dependency-cruiser collapses repeated references to one specifier
      // into a single dependency, but that is its behavior, not its contract;
      // an ordinal keeps ids unique either way, as the reference scanner does.
      const seen = new Map<string, number>()

      for (const dependency of module.dependencies) {
        const specifier = specifierOf(dependency)
        const ordinal = seen.get(specifier) ?? 0
        seen.set(specifier, ordinal + 1)

        observations.push(
          dependencyObservation(
            repositoryRoot,
            declaredPackages,
            tsconfigPaths,
            from,
            specifier,
            dependency,
            ordinal,
          ),
        )
      }
    }

    return observations
  }
}

/**
 * The parsed tsconfig contents, when one was configured.
 *
 * dependency-cruiser's own `extract-ts-config` does the parsing (it flattens
 * `extends` chains the way the cruiser expects); an unreadable or invalid
 * tsconfig throws, which the pipeline reports as a provider failure rather
 * than resolving without the aliases and calling the result clean.
 */
async function parsedTsconfig(
  repositoryRoot: string,
  tsconfigPath: string | undefined,
): Promise<ParsedTsconfig | undefined> {
  if (tsconfigPath === undefined) return undefined
  const { default: extractTSConfig } = await import(
    'dependency-cruiser/config-utl/extract-ts-config'
  )
  return extractTSConfig(path.resolve(repositoryRoot, tsconfigPath)) as ParsedTsconfig
}

/** The slice of a parsed tsconfig this provider reads. */
interface ParsedTsconfig {
  options?: { paths?: Record<string, unknown> }
}

async function cruiseRepository(
  repositoryRoot: string,
  roots: string[],
  options: DependencyCruiserOptions,
  tsconfig: ParsedTsconfig | undefined,
): Promise<ICruiseResult> {
  const cruiseOptions: ICruiseOptions = {
    baseDir: repositoryRoot,
    // Followed, they would drag every transitive package file into the module
    // list; the dependency edge into them is still observed and marked
    // external below.
    doNotFollow: { path: ['node_modules'] },
    validate: false,
  }

  let resolveOptions: Partial<IResolveOptions> | undefined
  let transpileOptions: ITranspileOptions | undefined

  if (options.tsconfigPath !== undefined && tsconfig !== undefined) {
    cruiseOptions.tsConfig = { fileName: options.tsconfigPath }
    transpileOptions = { tsConfig: tsconfig }
  }

  if (options.webpackConfigPath !== undefined) {
    const { default: extractWebpackResolveConfig } = await import(
      'dependency-cruiser/config-utl/extract-webpack-resolve-config'
    )
    resolveOptions = (await extractWebpackResolveConfig(
      path.resolve(repositoryRoot, options.webpackConfigPath),
    )) as Partial<IResolveOptions>
    cruiseOptions.webpackConfig = { fileName: options.webpackConfigPath }
  }

  // cruise() reports failures by throwing; the pipeline turns that into a
  // provider-failure finding. Nothing here catches, because half a scan
  // committed as a result would be a misleading one.
  const result = await cruise(roots, cruiseOptions, resolveOptions, transpileOptions)

  if (typeof result.output === 'string') {
    throw new Error('dependency-cruiser returned a report string instead of a cruise result')
  }
  return result.output
}

/**
 * The modules that are this repository's own code.
 *
 * The cruise output also lists synthetic entries for everything the edges
 * point at — node_modules packages, core modules, unresolvable specifiers.
 * Those stay visible as dependency targets but are not files in scope for
 * ownership.
 */
function internalModules(result: ICruiseResult): IModule[] {
  return result.modules.filter(
    (module) =>
      module.coreModule !== true &&
      module.couldNotResolve !== true &&
      isRepositoryPath(module.source),
  )
}

/** Repository-relative and not inside an installed dependency. */
function isRepositoryPath(source: string): boolean {
  if (path.isAbsolute(source)) return false
  const segments = source.split('/')
  if (segments[0] === '..' || segments[0] === '.') return false
  return !segments.includes('node_modules')
}

function isUnder(source: string, prefix: string): boolean {
  if (prefix === '' || prefix === '.') return true
  return source === prefix || source.startsWith(`${prefix}/`)
}

function bySource(a: IModule, b: IModule): number {
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0
}

/**
 * The specifier as written in the source.
 *
 * dependency-cruiser splits a URI specifier into `module` and `protocol`
 * (`import 'node:path'` reports `module: 'path'`, `protocol: 'node:'`);
 * the observation vocabulary wants the specifier as the author wrote it.
 */
function specifierOf(dependency: IDependency): string {
  const protocol = dependency.protocol
  if (protocol !== undefined && !dependency.module.startsWith(protocol)) {
    return `${protocol}${dependency.module}`
  }
  return dependency.module
}

type DependencyKind = 'import' | 'require' | 'dynamic-import' | string

function dependencyKindOf(dependency: IDependency): DependencyKind {
  if (dependency.dynamic) return 'dynamic-import'
  if (dependency.moduleSystem === 'cjs') return 'require'
  if (dependency.moduleSystem === 'es6') return 'import'
  return dependency.moduleSystem
}

function dependencyObservation(
  repositoryRoot: string,
  declaredPackages: DeclaredPackageLookup,
  tsconfigPaths: string[],
  from: string,
  specifier: string,
  dependency: IDependency,
  ordinal: number,
): Observation {
  const suffix = ordinal === 0 ? '' : `#${ordinal}`
  const evidence = [{ path: from, detail: specifier }]
  const base = {
    id: `dependency:${from}->${specifier}${suffix}`,
    kind: 'dependency',
    subject: { kind: 'file', id: from },
    evidence,
    provider: PROVIDER_ID,
  } as const

  const dependencyKind = dependencyKindOf(dependency)

  if (dependency.couldNotResolve) {
    // A specifier that resolves to nothing is only safely "external" when it
    // is demonstrably not our code: a Node builtin, or a package declared in
    // a manifest between the importing file and the repository root. A broken
    // relative path, a tsconfig alias whose mapping is wrong, and a phantom
    // package all get flagged instead — classifying them as external would
    // silently drop the dependency from the architecture check.
    const external = isKnownExternal(
      specifier,
      tsconfigPaths,
      declaredPackages,
      path.dirname(path.join(repositoryRoot, from)),
    )
    return {
      ...base,
      kind: external ? 'dependency' : 'unresolved-dependency',
      target: { kind: 'module', id: specifier },
      description: external
        ? `${from} depends on external module ${specifier}`
        : `${from} references ${specifier}, which does not resolve`,
      data: { specifier, dependencyKind, external, resolved: false },
    }
  }

  const to =
    dependency.coreModule || !isRepositoryPath(dependency.resolved)
      ? undefined
      : dependency.resolved

  if (to === undefined) {
    return {
      ...base,
      target: { kind: 'module', id: specifier },
      description: `${from} depends on external module ${specifier}`,
      data: { specifier, dependencyKind, external: true, resolved: true },
    }
  }

  return {
    ...base,
    target: { kind: 'file', id: to },
    description: `${from} depends on ${to}`,
    data: { specifier, dependencyKind, external: false, resolved: true },
  }
}

/**
 * Whether an unresolvable non-relative specifier is demonstrably not our code.
 *
 * Mirrors the built-in scanner: builtins are always external, a specifier
 * matching a tsconfig `paths` pattern was meant to map into this repository,
 * and anything else must be declared in a `package.json` between the
 * importing file and the repository root.
 */
function isKnownExternal(
  specifier: string,
  tsconfigPaths: string[],
  declaredPackages: DeclaredPackageLookup,
  fromDirectory: string,
): boolean {
  if (specifier.startsWith('.')) return false
  if (isBuiltin(specifier)) return true
  if (matchesPathsAlias(specifier, tsconfigPaths)) return false
  return declaredPackages.isDeclared(fromDirectory, packageNameOf(specifier))
}

/** Whether a specifier matches any tsconfig `paths` pattern (`@app/*`, exact names). */
function matchesPathsAlias(specifier: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const star = pattern.indexOf('*')
    if (star === -1) {
      if (pattern === specifier) return true
      continue
    }
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      return true
    }
  }
  return false
}

/** The package a specifier names: `@scope/name/deep` → `@scope/name`, `name/deep` → `name`. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  if (specifier.startsWith('@') && segments.length >= 2) return `${segments[0]}/${segments[1]}`
  return segments[0] ?? specifier
}

interface DeclaredPackageLookup {
  /** Whether any package.json from `fromDirectory` up to the repository root declares `name`. */
  isDeclared(fromDirectory: string, name: string): boolean
}

/**
 * Declared dependencies per directory, read lazily and cached for the run.
 *
 * Walks manifests rather than probing node_modules: a phantom dependency —
 * present on disk through hoisting but declared nowhere — is exactly what
 * must not pass as external.
 */
function declaredPackageLookup(repositoryRoot: string): DeclaredPackageLookup {
  const byDirectory = new Map<string, Set<string>>()

  const declaredIn = (directory: string): Set<string> => {
    const cached = byDirectory.get(directory)
    if (cached !== undefined) return cached

    const names = new Set<string>()
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>
        const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        for (const field of fields) {
          const block = parsed[field]
          if (block !== null && typeof block === 'object') {
            for (const name of Object.keys(block)) names.add(name)
          }
        }
      } catch {
        // An unreadable manifest declares nothing; the specifiers that needed
        // it surface as unresolved-dependency observations instead.
      }
    }
    byDirectory.set(directory, names)
    return names
  }

  const root = path.resolve(repositoryRoot)
  return {
    isDeclared(fromDirectory: string, name: string): boolean {
      let current = path.resolve(fromDirectory)
      for (;;) {
        if (declaredIn(current).has(name)) return true
        if (current === root) return false
        const parent = path.dirname(current)
        if (parent === current) return false
        current = parent
      }
    },
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Test files are excluded from the architecture scan, mirroring the built-in
 * scanner: a test crossing a boundary is a testing decision, not a declared
 * architectural dependency. Extended from the reference's TypeScript
 * extensions to the JavaScript ones this scanner also covers.
 */
export function isTestPath(relative: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(relative)) return true
  return relative
    .split('/')
    .slice(0, -1)
    .some((segment) => /^(__tests__|__mocks__|tests?|specs?)$/i.test(segment))
}
