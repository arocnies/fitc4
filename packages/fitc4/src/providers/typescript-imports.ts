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
          dependencyObservation(context, compilerOptions, absolute, relative, reference, ordinal),
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
    // A relative specifier that resolves to nothing is a broken import, not a
    // package. Classifying it as external would silently drop the dependency
    // from the architecture check.
    const relative = reference.specifier.startsWith('.')
    return {
      ...base,
      kind: relative ? 'unresolved-dependency' : 'dependency',
      target: { kind: 'module', id: reference.specifier },
      description: `${from} references ${reference.specifier}, which does not resolve`,
      data: {
        specifier: reference.specifier,
        dependencyKind: reference.dependencyKind,
        external: !relative,
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

function readCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    throw new Error(
      `Cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`,
    )
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
