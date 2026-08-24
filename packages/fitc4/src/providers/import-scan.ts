/**
 * The `import-scan` scan provider.
 *
 * A deterministic multi-language import crawler: walks the configured roots,
 * extracts import declarations lexically per language, and resolves them
 * against the file tree. No compiler, no AI call, no timeout; a repository of
 * thousands of files scans in well under a second. This is the out-of-the-box
 * scanner for repositories the TypeScript scanner cannot read, and the scan
 * `fitc4 draft` leans on for brownfield models.
 *
 * Languages read: Python, JavaScript/TypeScript, Go, Rust, Java, Kotlin,
 * Ruby, C/C++. The extraction is lexical (regular expressions over source
 * text), so it sees the declared import graph, not build-tool resolution:
 * a TypeScript project with tsconfig path aliases belongs to
 * `typescriptImports`, and domains no parser covers (compose files, docs,
 * infra) belong to `agentScan`. Do not run this and `typescriptImports` over
 * the same roots; they would observe the same imports twice.
 *
 * Standard-library imports are skipped, matching `agentScan`'s default
 * instructions: the runtime is not part of this architecture. External
 * packages become `module` targets in each ecosystem's claimable name
 * (Python: the top-level module, Go: the module path from go.mod, JS: the
 * specifier as written), so `packages` metadata claims work naturally.
 *
 * Fail-loud contracts, same as the TypeScript scanner: no roots, a root that
 * is not a directory, or a root with no source in a language this provider
 * reads all throw, because an empty scan must never look like a clean one. An
 * import that looks repository-local but resolves to no file becomes an
 * `unresolved-dependency`, never silence.
 */

import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'

import type { Evidence, NamedProvider, Observation, ScanContext, ScanProvider } from '../types.ts'

export const PROVIDER_ID = 'import-scan'

/** Never source, at any depth. */
const ALWAYS_SKIPPED = new Set(['node_modules', '__pycache__', 'venv', 'site-packages'])

/**
 * Build output and vendored dependencies, skipped only at the repository
 * root, where the conventional names are unambiguous. A real source directory
 * can legitimately be named `src/vendor/`, and dropping it silently would
 * remove it from coverage with no finding.
 */
const SKIPPED_AT_ROOT = new Set(['dist', 'build', 'out', 'coverage', 'target', 'vendor'])

/**
 * Tooling configuration at the repository root (fitc4.config.mts,
 * vite.config.ts, eslint.config.js, ...): build wiring, not architecture.
 * Root-only, like the build-output skips: `src/anything.config.ts` is code.
 */
const ROOT_CONFIG_FILE = /\.config\.[cm]?[jt]s$/

/** Files between progress reports; small repositories finish before the first. */
const PROGRESS_BATCH = 500

export interface ImportScanOptions {
  /**
   * Repository-relative directories to enumerate. Default: `['.']`, the whole
   * repository minus the conventional skip list, so `importScan()` with
   * nothing written is a working scanner. Narrow it when generated or
   * example code would otherwise pollute the observations.
   */
  roots?: string[]
}

export function importScan(options: ImportScanOptions = {}): NamedProvider<ScanProvider> {
  const roots = options.roots ?? ['.']

  const run: ScanProvider = async (context: ScanContext): Promise<Observation[]> => {
    if (roots.length === 0) {
      throw new Error('no scan roots configured; there is nothing under architecture control')
    }

    const view = enumerate(context.repositoryRoot, roots)
    const observations: Observation[] = []

    for (const root of roots) {
      const normalizedRoot = normalizeRoot(root)
      const sources = view.sources.filter(
        (file) => normalizedRoot === '' || file.startsWith(`${normalizedRoot}/`),
      )
      if (sources.length === 0) {
        throw new Error(
          `scan root '${root}' contains no source in a language importScan reads. ` +
            `For TypeScript with a tsconfig use typescriptImports; for other domains use agentScan`,
        )
      }
      observations.push({
        id: `scan-root:${root}`,
        kind: 'scan-root',
        subject: { kind: 'directory', id: normalizedRoot === '' ? '.' : normalizedRoot },
        description: `${root} is under architecture control`,
        data: { files: sources.length },
        provider: PROVIDER_ID,
      })
    }

    let scanned = 0
    for (const relative of view.sources) {
      scanned += 1
      if (view.sources.length > PROGRESS_BATCH && scanned % PROGRESS_BATCH === 0) {
        context.progress?.(`scanned ${scanned} of ${view.sources.length} files`)
      }

      observations.push({
        id: `file:${relative}`,
        kind: 'file',
        subject: { kind: 'file', id: relative },
        evidence: [{ path: relative }],
        provider: PROVIDER_ID,
      })

      const language = languageOf(relative)
      if (language === undefined) continue
      const text = fs.readFileSync(path.join(context.repositoryRoot, relative), 'utf8')

      // Two references to one specifier can share a line. An ordinal keeps
      // their ids distinct without making every id churn when a line moves.
      const seen = new Map<string, number>()

      for (const reference of language.references(text)) {
        const key = `${reference.line}->${reference.specifier}`
        const ordinal = seen.get(key) ?? 0
        seen.set(key, ordinal + 1)

        const resolution = language.resolve(reference.specifier, relative, view)
        if (resolution.type === 'skipped') continue
        observations.push(
          dependencyObservation(relative, reference, ordinal, language.id, resolution),
        )
      }
    }

    return observations
  }

  return { id: PROVIDER_ID, run }
}

interface ImportReference {
  specifier: string
  line: number
  /** Character offset of the match, so overlap dedup never merges two real references. */
  offset: number
}

type Resolution =
  | { type: 'file'; path: string }
  | { type: 'module'; id: string }
  | { type: 'unresolved' }
  /** Standard library or runtime-provided: not part of this architecture. */
  | { type: 'skipped' }

interface Language {
  id: string
  extensions: string[]
  references(text: string): ImportReference[]
  resolve(specifier: string, file: string, view: RepositoryView): Resolution
}

/**
 * What one enumeration pass learned about the repository, shared by every
 * language's resolution: the file set (existence checks never touch the disk
 * again), the directory set (package-directory imports), and a basename index
 * (suffix lookups for dotted-package languages).
 */
interface RepositoryView {
  /** Sorted repository-relative POSIX paths of the recognized, non-test sources. */
  sources: string[]
  hasFile(relative: string): boolean
  hasDirectory(relative: string): boolean
  /** Sorted files directly inside the directory, non-test only. */
  filesIn(directory: string): string[]
  /** Sorted enumerated paths whose basename is `name`. */
  withBasename(name: string): string[]
  /** Sorted enumerated directories whose path ends with `/${suffix}` (or equals it). */
  directoriesEndingWith(suffix: string): string[]
  /** The prefixes local dotted imports may resolve under: '', the roots, and conventional source dirs. */
  prefixes: string[]
  /** Parsed go.mod at the repository root, if one exists. */
  goModule(): GoModule | undefined
}

interface GoModule {
  name: string
  /** Required module paths, longest first, for prefix-matching import paths. */
  requires: string[]
}

function dependencyObservation(
  from: string,
  reference: ImportReference,
  ordinal: number,
  language: string,
  resolution: Exclude<Resolution, { type: 'skipped' }>,
): Observation {
  const suffix = ordinal === 0 ? '' : `#${ordinal}`
  const evidence: Evidence[] = [{ path: from, line: reference.line, detail: reference.specifier }]
  const base = {
    id: `dependency:${from}:${reference.line}${suffix}->${reference.specifier}`,
    kind: 'dependency',
    subject: { kind: 'file', id: from },
    evidence,
    provider: PROVIDER_ID,
  } as const

  if (resolution.type === 'file') {
    return {
      ...base,
      target: { kind: 'file', id: resolution.path },
      description: `${from} depends on ${resolution.path}`,
      data: { specifier: reference.specifier, language, external: false, resolved: true },
    }
  }
  if (resolution.type === 'module') {
    return {
      ...base,
      target: { kind: 'module', id: resolution.id },
      description: `${from} depends on external module ${reference.specifier}`,
      data: { specifier: reference.specifier, language, external: true, resolved: false },
    }
  }
  return {
    ...base,
    kind: 'unresolved-dependency',
    target: { kind: 'module', id: reference.specifier },
    description: `${from} references ${reference.specifier}, which does not resolve`,
    data: { specifier: reference.specifier, language, external: false, resolved: false },
  }
}

// --- enumeration ---

function enumerate(repositoryRoot: string, roots: string[]): RepositoryView {
  const files = new Set<string>()
  const directories = new Set<string>()

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
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
        directories.add(toPosix(path.relative(repositoryRoot, absolute)))
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (
        ROOT_CONFIG_FILE.test(entry.name) &&
        path.dirname(absolute) === path.resolve(repositoryRoot)
      ) {
        continue
      }
      files.add(toPosix(path.relative(repositoryRoot, absolute)))
    }
  }

  for (const root of roots) {
    const absolute = path.resolve(repositoryRoot, root)
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
      throw new Error(`scan root '${root}' is not a directory`)
    }
    walk(absolute)
  }

  const sources = [...files]
    .filter((file) => languageOf(file) !== undefined && !isTestPath(file))
    .sort()

  const byBasename = new Map<string, string[]>()
  for (const file of [...files].sort()) {
    const name = file.split('/').at(-1) ?? file
    const existing = byBasename.get(name)
    if (existing === undefined) byBasename.set(name, [file])
    else existing.push(file)
  }

  const sortedDirectories = [...directories].sort()

  const normalizedRoots = roots.map(normalizeRoot).filter((root) => root !== '')
  const prefixes = [...new Set(['', ...normalizedRoots, 'src', 'lib'])]

  let goModule: GoModule | undefined | null = null
  return {
    sources,
    hasFile: (relative) => files.has(relative),
    hasDirectory: (relative) => directories.has(relative),
    filesIn: (directory) =>
      [...files]
        .filter(
          (file) =>
            file.startsWith(`${directory}/`) &&
            !file.slice(directory.length + 1).includes('/') &&
            !isTestPath(file),
        )
        .sort(),
    withBasename: (name) => byBasename.get(name) ?? [],
    directoriesEndingWith: (suffix) =>
      sortedDirectories.filter(
        (directory) => directory === suffix || directory.endsWith(`/${suffix}`),
      ),
    prefixes,
    goModule: () => {
      if (goModule === null) goModule = readGoModule(repositoryRoot)
      return goModule
    },
  }
}

function normalizeRoot(root: string): string {
  const posix = toPosix(root).replace(/^\.\//, '').replace(/\/+$/, '')
  return posix === '.' ? '' : posix
}

function readGoModule(repositoryRoot: string): GoModule | undefined {
  const manifest = path.join(repositoryRoot, 'go.mod')
  if (!fs.existsSync(manifest)) return undefined
  const text = fs.readFileSync(manifest, 'utf8')
  const name = /^module\s+(\S+)/m.exec(text)?.[1]
  if (name === undefined) return undefined
  const requires = [...text.matchAll(/^(?:require\s+)?\s*([\w.\-~/]+)\s+v[\w.\-+]+/gm)]
    .map((match) => match[1] ?? '')
    .filter((entry) => entry !== '' && entry !== 'module' && entry !== 'go')
    .sort((a, b) => b.length - a.length)
  return { name, requires }
}

/**
 * Test files are excluded from the architecture scan, same as the TypeScript
 * scanner: a test crossing a boundary is a testing decision, not a declared
 * architectural dependency. Directory conventions plus each language's
 * filename conventions count.
 */
export function isTestPath(relative: string): boolean {
  const base = relative.split('/').at(-1) ?? relative
  if (/\.(test|spec)\.\w+$/i.test(base)) return true
  if (/^test_.*\.py$/.test(base) || /_test\.(py|go|rb)$/.test(base)) return true
  if (/(Test|Tests|IT)\.(java|kt)$/.test(base) || /_spec\.rb$/.test(base)) return true
  return relative
    .split('/')
    .slice(0, -1)
    .some((segment) => /^(__tests__|__mocks__|tests?|specs?|testdata)$/i.test(segment))
}

// --- shared extraction helpers ---

/** All matches of `pattern` (must carry the g flag) as references, capture group 1. */
function matchReferences(text: string, pattern: RegExp, lineOf: (offset: number) => number): ImportReference[] {
  const references: ImportReference[] = []
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier === undefined || specifier === '') continue
    references.push({ specifier, line: lineOf(match.index), offset: match.index })
  }
  return references
}

/** 1-based line number per character offset, computed once per file. */
function lineIndexer(text: string): (offset: number) => number {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] ?? 0) <= offset) low = mid
      else high = mid - 1
    }
    return low + 1
  }
}

/**
 * One reference per distinct match position: two patterns for one language
 * matching the same declaration would be a parsing artifact, while two real
 * references sharing a line still match at different offsets and both stay.
 * Sorted by position so ids and ordinals follow source order.
 */
function distinct(references: ImportReference[]): ImportReference[] {
  const seen = new Set<string>()
  return references
    .filter((reference) => {
      const key = `${reference.offset}->${reference.specifier}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.offset - b.offset)
}

/** Join and normalize a relative specifier against the importing file's directory. */
function joinRelative(file: string, specifier: string): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  if (joined.startsWith('..')) return undefined
  return joined === '.' ? '' : joined
}

// --- Python ---

/** `sys.stdlib_module_names`, public names only, plus `__future__`. */
const PYTHON_STDLIB = new Set([
  '__future__', 'abc', 'annotationlib', 'antigravity', 'argparse', 'array', 'ast', 'asyncio',
  'atexit', 'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar',
  'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'compression', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg',
  'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis',
  'doctest', 'email', 'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl',
  'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'genericpath',
  'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac',
  'html', 'http', 'idlelib', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools',
  'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'marshal', 'math',
  'mimetypes', 'mmap', 'modulefinder', 'msvcrt', 'multiprocessing', 'netrc', 'nt', 'ntpath',
  'nturl2path', 'numbers', 'opcode', 'operator', 'optparse', 'os', 'pathlib', 'pdb', 'pickle',
  'pickletools', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat',
  'queue', 'quopri', 'random', 're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy',
  'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtplib', 'socket', 'socketserver', 'sqlite3', 'sre_compile', 'sre_constants', 'sre_parse',
  'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'tempfile', 'termios', 'textwrap',
  'this', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
  'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg',
  'winsound', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
])

const python: Language = {
  id: 'python',
  extensions: ['.py'],
  references(text) {
    const lineOf = lineIndexer(text)
    const references: ImportReference[] = []
    // `import a.b, c as d`: one reference per comma entry.
    for (const match of text.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
      for (const entry of (match[1] ?? '').split(',')) {
        const name = /^\s*([A-Za-z_][\w.]*)/.exec(entry)?.[1]
        if (name !== undefined) {
          references.push({ specifier: name, line: lineOf(match.index), offset: match.index })
        }
      }
    }
    // `from <dots><module> import ...`: the dependency is on the module part.
    for (const match of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import\b/gm)) {
      const specifier = match[1] ?? ''
      if (specifier !== '') {
        references.push({ specifier, line: lineOf(match.index), offset: match.index })
      }
    }
    return distinct(references)
  },
  resolve(specifier, file, view) {
    const dots = /^\.*/.exec(specifier)?.[0].length ?? 0
    if (dots > 0) {
      // Relative: one dot is the file's own package, each further dot one up.
      let base = path.posix.dirname(file)
      for (let up = 1; up < dots; up += 1) base = path.posix.dirname(base)
      if (base === '.') base = ''
      const rest = specifier.slice(dots)
      if (rest === '') {
        const marker = base === '' ? '__init__.py' : `${base}/__init__.py`
        // `from . import x` in a namespace package (no __init__.py) is an
        // intra-package import with no file to point at: skip, not a finding.
        return view.hasFile(marker) ? { type: 'file', path: marker } : { type: 'skipped' }
      }
      const stem = base === '' ? rest.replaceAll('.', '/') : `${base}/${rest.replaceAll('.', '/')}`
      if (view.hasFile(`${stem}.py`)) return { type: 'file', path: `${stem}.py` }
      if (view.hasFile(`${stem}/__init__.py`)) return { type: 'file', path: `${stem}/__init__.py` }
      return { type: 'unresolved' }
    }

    const first = specifier.split('.')[0] ?? specifier
    if (PYTHON_STDLIB.has(first)) return { type: 'skipped' }

    const stem = specifier.replaceAll('.', '/')
    let localPackage = false
    for (const prefix of view.prefixes) {
      const candidate = prefix === '' ? stem : `${prefix}/${stem}`
      if (view.hasFile(`${candidate}.py`)) return { type: 'file', path: `${candidate}.py` }
      if (view.hasFile(`${candidate}/__init__.py`)) {
        return { type: 'file', path: `${candidate}/__init__.py` }
      }
      const top = prefix === '' ? first : `${prefix}/${first}`
      if (view.hasDirectory(top) || view.hasFile(`${top}.py`)) localPackage = true
    }
    // The top-level name exists in this repository but the dotted path under
    // it does not: a broken local import, not an external package.
    return localPackage ? { type: 'unresolved' } : { type: 'module', id: first }
  },
}

// --- JavaScript / TypeScript (lexical; use typescriptImports when a tsconfig exists) ---

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

const javascript: Language = {
  id: 'javascript',
  extensions: JS_EXTENSIONS,
  references(text) {
    const lineOf = lineIndexer(text)
    return distinct([
      // Static imports and bare side-effect imports, multi-line clauses included.
      ...matchReferences(text, /\bimport\s+(?:[\w*{}\s,$]+?from\s*)?['"]([^'"\n]+)['"]/g, lineOf),
      ...matchReferences(text, /\bexport\s+[\w*{}\s,$]+?from\s*['"]([^'"\n]+)['"]/g, lineOf),
      ...matchReferences(text, /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g, lineOf),
      ...matchReferences(text, /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g, lineOf),
    ])
  },
  resolve(rawSpecifier, file, view) {
    // Browser ES modules append cache-busting queries (`./x.js?v=3`); the
    // file behind the specifier is what the dependency is on.
    const specifier = (rawSpecifier.split(/[?#]/)[0] ?? rawSpecifier) || rawSpecifier
    if (specifier.startsWith('.')) {
      const stem = joinRelative(file, specifier)
      if (stem === undefined) return { type: 'unresolved' }
      if (view.hasFile(stem)) return { type: 'file', path: stem }
      for (const extension of JS_EXTENSIONS) {
        if (view.hasFile(`${stem}${extension}`)) return { type: 'file', path: `${stem}${extension}` }
        // An explicit .js specifier compiled from a .ts source.
        const swapped: string = stem.replace(/\.[cm]?jsx?$/, extension)
        if (swapped !== stem && view.hasFile(swapped)) return { type: 'file', path: swapped }
        if (view.hasFile(`${stem}/index${extension}`)) {
          return { type: 'file', path: `${stem}/index${extension}` }
        }
      }
      return { type: 'unresolved' }
    }
    if (specifier.startsWith('/')) return { type: 'skipped' }
    if (specifier.startsWith('node:') || isBuiltin(specifier)) return { type: 'skipped' }
    return { type: 'module', id: specifier }
  },
}

// --- Go ---

const go: Language = {
  id: 'go',
  extensions: ['.go'],
  references(text) {
    const lineOf = lineIndexer(text)
    const references = matchReferences(text, /^import\s+(?:\w+\s+)?"([^"\n]+)"/gm, lineOf)
    for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
      const body = block[1] ?? ''
      const bodyStart = block.index + block[0].indexOf(body)
      for (const match of body.matchAll(/(?:^|\n)\s*(?:[\w.]+\s+)?"([^"\n]+)"/g)) {
        const specifier = match[1]
        if (specifier === undefined) continue
        references.push({ specifier, line: lineOf(bodyStart + match.index), offset: bodyStart + match.index })
      }
    }
    return distinct(references)
  },
  resolve(specifier, _file, view) {
    const module = view.goModule()
    if (module !== undefined && (specifier === module.name || specifier.startsWith(`${module.name}/`))) {
      const directory = specifier === module.name ? '' : specifier.slice(module.name.length + 1)
      // A Go import names a package directory; the dependency lands on its
      // first source file so every downstream consumer keeps working on file
      // targets, and ownership resolves identically for any file in the
      // directory.
      const inside = view.filesIn(directory).filter((file) => file.endsWith('.go'))
      const representative = inside[0]
      if (representative !== undefined) return { type: 'file', path: representative }
      return { type: 'unresolved' }
    }
    const first = specifier.split('/')[0] ?? specifier
    // Standard-library import paths have no dot in their first segment.
    if (!first.includes('.')) return { type: 'skipped' }
    const required = module?.requires.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    )
    return { type: 'module', id: required ?? specifier }
  },
}

// --- Rust (best-effort: an unmapped crate-local use is skipped, never a false finding) ---

const rust: Language = {
  id: 'rust',
  extensions: ['.rs'],
  references(text) {
    const lineOf = lineIndexer(text)
    return distinct([
      ...matchReferences(text, /^\s*(?:pub(?:\([\w:\s]*\))?\s+)?use\s+([\w:]+)/gm, lineOf),
      ...matchReferences(text, /^\s*extern\s+crate\s+(\w+)/gm, lineOf),
      // `mod x;` declares a child module file; `mod x {` is inline and excluded.
      ...matchReferences(text, /^\s*(?:pub(?:\([\w:\s]*\))?\s+)?mod\s+(\w+)\s*;/gm, lineOf).map(
        (reference) => ({ ...reference, specifier: `mod ${reference.specifier}` }),
      ),
    ]).map((reference) => ({
      ...reference,
      specifier: reference.specifier.replace(/:+$/, ''),
    }))
  },
  resolve(specifier, file, view) {
    if (specifier.startsWith('mod ')) {
      const name = specifier.slice(4)
      const basename = file.split('/').at(-1) ?? file
      const base = ['mod.rs', 'lib.rs', 'main.rs'].includes(basename)
        ? path.posix.dirname(file)
        : file.replace(/\.rs$/, '')
      const dir = base === '.' ? '' : base
      const stem = dir === '' ? name : `${dir}/${name}`
      if (view.hasFile(`${stem}.rs`)) return { type: 'file', path: `${stem}.rs` }
      if (view.hasFile(`${stem}/mod.rs`)) return { type: 'file', path: `${stem}/mod.rs` }
      return { type: 'unresolved' }
    }

    const segments = specifier.split('::').filter((segment) => segment !== '')
    const first = segments[0] ?? ''
    if (first === 'std' || first === 'core' || first === 'alloc') return { type: 'skipped' }
    // Same-module and parent-module paths stay inside one file's neighborhood.
    if (first === 'self' || first === 'super') return { type: 'skipped' }
    if (first === 'crate') {
      // The crate root is the nearest enclosing src/; trailing segments may be
      // symbols rather than modules, so try progressively shorter paths.
      const sourceIndex = file.split('/').indexOf('src')
      const base = sourceIndex === -1 ? '' : file.split('/').slice(0, sourceIndex + 1).join('/')
      for (let length = segments.length - 1; length >= 1; length -= 1) {
        const stem = [base, ...segments.slice(1, length + 1)].filter((part) => part !== '').join('/')
        if (view.hasFile(`${stem}.rs`)) return { type: 'file', path: `${stem}.rs` }
        if (view.hasFile(`${stem}/mod.rs`)) return { type: 'file', path: `${stem}/mod.rs` }
      }
      return { type: 'skipped' }
    }
    return { type: 'module', id: first }
  },
}

// --- Java / Kotlin ---

const JVM_STDLIB_PREFIXES = new Set(['java', 'javax', 'kotlin'])

const jvm: Language = {
  id: 'jvm',
  extensions: ['.java', '.kt', '.kts'],
  references(text) {
    const lineOf = lineIndexer(text)
    return distinct(
      matchReferences(text, /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)(?:\s+as\s+\w+)?\s*;?\s*$/gm, lineOf),
    )
  },
  resolve(specifier, _file, view) {
    const first = specifier.split('.')[0] ?? specifier
    if (JVM_STDLIB_PREFIXES.has(first)) return { type: 'skipped' }

    if (specifier.endsWith('.*')) {
      const packagePath = specifier.slice(0, -2).replaceAll('.', '/')
      const directory = view.directoriesEndingWith(packagePath)[0]
      if (directory !== undefined) {
        const inside = view
          .filesIn(directory)
          .filter((file) => file.endsWith('.java') || file.endsWith('.kt'))
        const representative = inside[0]
        if (representative !== undefined) return { type: 'file', path: representative }
      }
      return { type: 'module', id: specifier.slice(0, -2) }
    }

    // Package segments are lowercase by convention; the first capitalized
    // segment is the type, and its source file carries the type's name.
    const segments = specifier.split('.')
    const typeIndex = segments.findIndex((segment) => /^[A-Z]/.test(segment))
    if (typeIndex > 0) {
      const packagePath = segments.slice(0, typeIndex).join('/')
      for (const extension of ['.java', '.kt']) {
        const candidate = view
          .withBasename(`${segments[typeIndex]}${extension}`)
          .find((file) => file.includes(`${packagePath}/`))
        if (candidate !== undefined) return { type: 'file', path: candidate }
      }
      return { type: 'module', id: segments.slice(0, typeIndex).join('.') }
    }
    // No capitalized segment (a Kotlin top-level function, or an unusual
    // package): claimable as the package written.
    return { type: 'module', id: specifier }
  },
}

// --- Ruby ---

const RUBY_STDLIB = new Set([
  'abbrev', 'base64', 'benchmark', 'bigdecimal', 'cgi', 'csv', 'date', 'delegate', 'digest',
  'English', 'erb', 'etc', 'fcntl', 'fiddle', 'fileutils', 'find', 'forwardable', 'getoptlong',
  'io/console', 'io/nonblock', 'io/wait', 'ipaddr', 'irb', 'json', 'logger', 'monitor',
  'net/ftp', 'net/http', 'net/imap', 'net/pop', 'net/protocol', 'net/smtp', 'objspace',
  'observer', 'open-uri', 'open3', 'openssl', 'optparse', 'ostruct', 'pathname', 'pp',
  'prettyprint', 'prime', 'pstore', 'psych', 'pty', 'rdoc', 'readline', 'reline', 'resolv',
  'ripper', 'securerandom', 'set', 'shellwords', 'singleton', 'socket', 'stringio', 'strscan',
  'syslog', 'tempfile', 'time', 'timeout', 'tmpdir', 'tsort', 'uri', 'weakref', 'yaml', 'zlib',
])

const ruby: Language = {
  id: 'ruby',
  extensions: ['.rb'],
  references(text) {
    const lineOf = lineIndexer(text)
    return distinct([
      ...matchReferences(text, /^\s*require_relative\s+['"]([^'"\n]+)['"]/gm, lineOf).map(
        (reference) => ({ ...reference, specifier: `./${reference.specifier}` }),
      ),
      ...matchReferences(text, /^\s*require\s+['"]([^'"\n]+)['"]/gm, lineOf),
    ])
  },
  resolve(specifier, file, view) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const stem = joinRelative(file, specifier)
      if (stem !== undefined && view.hasFile(`${stem}.rb`)) {
        return { type: 'file', path: `${stem}.rb` }
      }
      return { type: 'unresolved' }
    }
    for (const prefix of view.prefixes) {
      const candidate = prefix === '' ? specifier : `${prefix}/${specifier}`
      if (view.hasFile(`${candidate}.rb`)) return { type: 'file', path: `${candidate}.rb` }
    }
    if (RUBY_STDLIB.has(specifier)) return { type: 'skipped' }
    return { type: 'module', id: specifier.split('/')[0] ?? specifier }
  },
}

// --- C / C++ ---

const c: Language = {
  id: 'c',
  extensions: ['.c', '.h', '.cc', '.hh', '.cpp', '.hpp', '.cxx', '.hxx'],
  references(text) {
    const lineOf = lineIndexer(text)
    return distinct([
      ...matchReferences(text, /^\s*#\s*include\s*"([^"\n]+)"/gm, lineOf),
      ...matchReferences(text, /^\s*#\s*include\s*<([^>\n]+)>/gm, lineOf).map((reference) => ({
        ...reference,
        specifier: `<${reference.specifier}>`,
      })),
    ])
  },
  resolve(specifier, file, view) {
    if (specifier.startsWith('<')) {
      const inner = specifier.slice(1, -1)
      // A pathless angle include (<vector>, <stdio.h>) is the toolchain's;
      // a pathed one (<boost/asio.hpp>) names an external library.
      if (!inner.includes('/')) return { type: 'skipped' }
      return { type: 'module', id: inner.split('/')[0] ?? inner }
    }
    const relative = joinRelative(file, specifier)
    if (relative !== undefined && view.hasFile(relative)) return { type: 'file', path: relative }
    for (const prefix of ['', 'include', 'src', ...view.prefixes]) {
      const candidate = prefix === '' ? specifier : `${prefix}/${specifier}`
      if (view.hasFile(candidate)) return { type: 'file', path: candidate }
    }
    return { type: 'unresolved' }
  },
}

const LANGUAGES: Language[] = [python, javascript, go, rust, jvm, ruby, c]

const LANGUAGE_BY_EXTENSION = new Map<string, Language>(
  LANGUAGES.flatMap((language) =>
    language.extensions.map((extension) => [extension, language] as const),
  ),
)

/** The extensions importScan reads, for callers that surface the language list. */
export const IMPORT_SCAN_EXTENSIONS: readonly string[] = [...LANGUAGE_BY_EXTENSION.keys()]

function languageOf(file: string): Language | undefined {
  const dot = file.lastIndexOf('.')
  if (dot === -1) return undefined
  return LANGUAGE_BY_EXTENSION.get(file.slice(dot))
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}
