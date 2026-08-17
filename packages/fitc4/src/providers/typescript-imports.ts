/**
 * The `typescript-imports` scan provider.
 *
 * Enumerates source files under the configured roots and extracts their module
 * references using the TypeScript compiler API. It observes implementation
 * facts only; it knows nothing about the architecture model.
 *
 * Coverage comes from walking the roots on disk, not from a `Program`'s file
 * list. A `Program` seeded from tsconfig contains only included files plus
 * whatever they transitively import, so a file nobody imports would never be
 * observed — and therefore never reported as unowned. Coverage must not depend
 * on import reachability.
 *
 * This uses `typescript@6`, held as a workspace-local dependency because
 * TypeScript 7.0.2 does not expose the classic compiler API (POC-DESIGN-v4).
 */

import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import ts from 'typescript'
import type { Observation, ScanContext } from '../types.ts'

export const PROVIDER_ID = 'typescript-imports'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

/** Never source, at any depth. */
const ALWAYS_SKIPPED = new Set(['node_modules'])

/**
 * Build output, skipped only at the repository root.
 *
 * A real source directory can legitimately be named `src/out/`, and dropping it
 * silently would remove it from coverage with no finding.
 */
const SKIPPED_AT_ROOT = new Set(['dist', 'build', 'out', 'coverage'])

export interface TypeScriptImportsOptions {
  /** Path to the tsconfig supplying compiler options (paths, baseUrl). */
  tsconfigPath: string
  /**
   * Repository-relative directories to enumerate.
   *
   * These bound what is under architecture control. They are deliberately not
   * derived from the model: a file can only be reported as unowned if the
   * scanner looked at it in the first place.
   */
  roots: string[]
}

export function typescriptImports(options: TypeScriptImportsOptions) {
  return async (context: ScanContext): Promise<Observation[]> => {
    const compilerOptions = readCompilerOptions(options.tsconfigPath)
    const declaredPackages = declaredPackageLookup(context.repositoryRoot)
    const observations: Observation[] = []

    // A scan root that does not exist, or holds no source, silently reduces
    // coverage to nothing — every violation disappears and the run goes green.
    // This is the same fail-open as unmatched ownership metadata, on the other
    // side of the comparison, so it fails just as loudly.
    if (options.roots.length === 0) {
      throw new Error('no scan roots configured; there is nothing under architecture control')
    }

    for (const root of options.roots) {
      const absolute = path.resolve(context.repositoryRoot, root)
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
        throw new Error(`scan root '${root}' is not a directory`)
      }

      const files = enumerateSources(context.repositoryRoot, [root])
      if (files.length === 0) {
        throw new Error(`scan root '${root}' contains no TypeScript source`)
      }

      observations.push({
        id: `scan-root:${root}`,
        kind: 'scan-root',
        subject: { kind: 'directory', id: toPosix(path.relative(context.repositoryRoot, absolute)) },
        description: `${root} is under architecture control`,
        data: { files: files.length },
        provider: PROVIDER_ID,
      })
    }

    for (const relative of enumerateSources(context.repositoryRoot, options.roots)) {
      if (isTestPath(relative)) continue

      observations.push({
        id: `file:${relative}`,
        kind: 'file',
        subject: { kind: 'file', id: relative },
        evidence: [{ path: relative }],
        provider: PROVIDER_ID,
      })

      const absolute = path.join(context.repositoryRoot, relative)
      const sourceFile = ts.createSourceFile(
        absolute,
        fs.readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      )

      // Two references to one specifier can share a line. An ordinal keeps
      // their ids distinct without making every id churn when a line moves.
      const seen = new Map<string, number>()

      for (const reference of moduleReferences(sourceFile)) {
        const key = `${reference.line}->${reference.specifier}`
        const ordinal = seen.get(key) ?? 0
        seen.set(key, ordinal + 1)

        observations.push(
          dependencyObservation(
            context,
            compilerOptions,
            declaredPackages,
            absolute,
            relative,
            reference,
            ordinal,
          ),
        )
      }
    }

    return observations
  }
}

/** Every source file under the configured roots, as repository-relative POSIX paths. */
export function enumerateSources(repositoryRoot: string, roots: string[]): string[] {
  const found: string[] = []

  const walk = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED.has(entry.name)) continue
        if (
          SKIPPED_AT_ROOT.has(entry.name) &&
          path.dirname(absolute) === path.resolve(repositoryRoot)
        ) {
          continue
        }
        walk(absolute)
        continue
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue

      found.push(toPosix(path.relative(repositoryRoot, absolute)))
    }
  }

  for (const root of roots) {
    walk(path.resolve(repositoryRoot, root))
  }

  return [...new Set(found)].sort()
}

type DependencyKind = 'import' | 're-export' | 'dynamic-import' | 'require'

interface ModuleReference {
  specifier: string
  dependencyKind: DependencyKind
  line: number
}

/**
 * Every module reference in a file.
 *
 * Walks the whole tree rather than top-level statements only: `await import()`
 * is the standard way to break a static cycle, so it is exactly the form that
 * must not escape the check.
 */
export function moduleReferences(sourceFile: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = []

  const record = (
    specifier: ts.Expression | undefined,
    dependencyKind: DependencyKind,
    node: ts.Node,
  ): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return
    references.push({
      specifier: specifier.text,
      dependencyKind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record(node.moduleSpecifier, 'import', node)
    } else if (ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, 're-export', node)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        record(node.moduleReference.expression, 'require', node)
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0], 'dynamic-import', node)
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record(node.arguments[0], 'require', node)
      } else if (isImportMetaResolve(node.expression)) {
        record(node.arguments[0], 'dynamic-import', node)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return references
}

/** `import.meta.resolve(...)` — a module reference the call-expression checks miss. */
function isImportMetaResolve(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false
  if (expression.name.text !== 'resolve') return false
  return ts.isMetaProperty(expression.expression)
}

function dependencyObservation(
  context: ScanContext,
  compilerOptions: ts.CompilerOptions,
  declaredPackages: DeclaredPackageLookup,
  containingFile: string,
  from: string,
  reference: ModuleReference,
  ordinal: number,
): Observation {
  const resolved = ts.resolveModuleName(
    reference.specifier,
    containingFile,
    compilerOptions,
    ts.sys,
  ).resolvedModule

  // The location is part of the id: two references from one file to one target
  // are distinct facts, and collapsing them loses the evidence location of all
  // but the last.
  const suffix = ordinal === 0 ? '' : `#${ordinal}`
  const evidence = [{ path: from, line: reference.line, detail: reference.specifier }]
  const base = {
    id: `dependency:${from}:${reference.line}${suffix}->${reference.specifier}`,
    kind: 'dependency',
    subject: { kind: 'file', id: from },
    evidence,
    provider: PROVIDER_ID,
  } as const

  if (resolved === undefined) {
    // A specifier that resolves to nothing is only safely "external" when it
    // is demonstrably not our code: a Node builtin, or a package this
    // repository declares. A broken relative path, a tsconfig alias whose
    // mapping is wrong, and an undeclared package all get flagged instead —
    // classifying them as external would silently drop the dependency from
    // the architecture check.
    const external = isKnownExternal(
      reference.specifier,
      compilerOptions,
      declaredPackages,
      path.dirname(containingFile),
    )
    return {
      ...base,
      kind: external ? 'dependency' : 'unresolved-dependency',
      target: { kind: 'module', id: reference.specifier },
      description: external
        ? `${from} depends on external module ${reference.specifier}`
        : `${from} references ${reference.specifier}, which does not resolve`,
      data: {
        specifier: reference.specifier,
        dependencyKind: reference.dependencyKind,
        external,
        resolved: false,
      },
    }
  }

  // `isExternalLibraryImport` is not the right test for "not our code": an npm
  // workspace package is reached through node_modules but lives in this
  // repository. Repository membership is what actually decides.
  const to = toRepositoryRelative(context.repositoryRoot, resolved.resolvedFileName)

  if (to === undefined) {
    return {
      ...base,
      target: { kind: 'module', id: reference.specifier },
      description: `${from} depends on external module ${reference.specifier}`,
      data: {
        specifier: reference.specifier,
        dependencyKind: reference.dependencyKind,
        external: true,
        resolved: true,
      },
    }
  }

  return {
    ...base,
    target: { kind: 'file', id: to },
    description: `${from} depends on ${to}`,
    data: {
      specifier: reference.specifier,
      dependencyKind: reference.dependencyKind,
      external: false,
      resolved: true,
    },
  }
}

/**
 * Whether an unresolvable non-relative specifier is demonstrably not our code.
 *
 * TypeScript resolution only finds packages that ship types, so a plain-JS
 * package legitimately fails to resolve here. The tell that separates it from
 * a broken alias or a phantom dependency: builtins are always external, a
 * specifier matching a tsconfig `paths` pattern was meant to map into this
 * repository, and anything else must be declared in a `package.json` between
 * the importing file and the repository root.
 */
function isKnownExternal(
  specifier: string,
  compilerOptions: ts.CompilerOptions,
  declaredPackages: DeclaredPackageLookup,
  fromDirectory: string,
): boolean {
  if (specifier.startsWith('.')) return false
  if (isBuiltin(specifier)) return true
  if (matchesPathsAlias(specifier, compilerOptions.paths)) return false
  return declaredPackages.isDeclared(fromDirectory, packageNameOf(specifier))
}

/** Whether a specifier matches any tsconfig `paths` pattern (`@app/*`, exact names). */
function matchesPathsAlias(
  specifier: string,
  paths: ts.MapLike<string[]> | undefined,
): boolean {
  if (paths === undefined) return false
  for (const pattern of Object.keys(paths)) {
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
 * present on disk through hoisting but declared nowhere — is exactly what must
 * not pass as external.
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
        // An unreadable manifest declares nothing; resolution failures against
        // it will surface as unresolved-dependency observations.
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

function readCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    // TypeScript's own message usually names the path already; prefixing it
    // again reads as "Cannot read X: Cannot read file 'X'".
    const detail = ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')
    throw new Error(detail.includes(tsconfigPath) ? detail : `Cannot read ${tsconfigPath}: ${detail}`)
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath),
  )
  const fatal = parsed.errors.filter((error) => error.category === ts.DiagnosticCategory.Error)
  if (fatal.length > 0) {
    const message = fatal
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' '))
      .join('; ')
    throw new Error(`Cannot parse ${tsconfigPath}: ${message}`)
  }

  return parsed.options
}

/**
 * Repository-relative POSIX path, or undefined when the file sits outside the
 * repository or inside an installed dependency.
 */
function toRepositoryRelative(repositoryRoot: string, fileName: string): string | undefined {
  const relative = path.relative(repositoryRoot, fileName)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined

  const posix = toPosix(relative)
  return posix.split('/').includes('node_modules') ? undefined : posix
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Test files are excluded from the architecture scan: a test crossing a
 * boundary is a testing decision, not a declared architectural dependency.
 * Both filename and directory conventions count.
 */
export function isTestPath(relative: string): boolean {
  if (/\.(test|spec)\.[cm]?tsx?$/i.test(relative)) return true
  return relative
    .split('/')
    .slice(0, -1)
    .some((segment) => /^(__tests__|__mocks__|tests?|specs?)$/i.test(segment))
}
