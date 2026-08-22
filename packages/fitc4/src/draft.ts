/**
 * `fitc4 draft`: bootstrap a first LikeC4 model from the code that exists.
 *
 * Runs the configured scan providers, with no model loaded, and turns what
 * they observed into a first-draft model. The draft mirrors the structure the
 * observations report, never the filesystem hierarchy:
 *
 * - Directory elements follow the observed dependency graph. Each scan root
 *   splits into its first-level directories; below that, a directory splits
 *   into nested child elements only where an observed dependency crosses
 *   between two of its subdirectories, and collapses into a single element
 *   where none does, however deep its folder tree goes. Granularity comes
 *   from the code's own structure, not from a folder convention or a knob.
 * - A `file` observation whose subject carries a fragment locator
 *   (`<path>#<fragment>`, the form the agent scanner blesses) becomes its own
 *   element, nested under an element for the containing file and claiming the
 *   locator verbatim. Fragments are opt-in at the scan instructions, so their
 *   presence in the observations is the user asking for them.
 * - A dependency target of a kind that is not a repository path or an npm
 *   package (a `system`, a `service`) becomes a description-only boundary
 *   element, one per distinct kind and id. Observed external npm packages are
 *   claimed by one vendor stub, as before.
 *
 * The draft is a starting point the human rewrites, never a sync. Every
 * relationship the gate can observe is tagged as tolerated drift by default,
 * so the very first gate run is green and the drift line becomes the adoption
 * burn-down; untagging an edge is the human act of blessing it as intended
 * architecture. Edges to boundary elements are the one exception: the gate
 * resolves no dependency onto a description-only element, so a drift tag
 * there would be born as `unused-drift` noise, and they are emitted as plain
 * declared edges instead.
 *
 * Elements and edges derive from observations, not from listing the
 * filesystem, so every emitted `sources` claim matches a scanned file or an
 * observed fragment and every emitted relationship covers an observed
 * dependency. The draft therefore cannot produce `unmatched-sources`,
 * `unmatched-packages`, or `unused-drift` findings against itself: the
 * generated model gates green by construction.
 */

import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { pipelineConfig } from './defaults.ts'
import { messageOf } from './errors.ts'
import { MODEL_FILENAME } from './init.ts'
import { packageNameOf, toPackageName } from './model.ts'
import { DEFAULT_DRIFT_TAG } from './providers/architecture-rules.ts'
import { ownerOf } from './providers/source-root.ts'
import { count, elapsed } from './report.ts'
import type { Observation, Progress } from './types.ts'

/**
 * The facts one drafted element offers a describe callback: everything the
 * callback needs to propose a description, and nothing that would let it
 * change anything else.
 */
export interface DraftElementFacts {
  /** The element title, the directory, file, or fragment name as observed. */
  name: string
  /** The dot-joined identifier path under the wrapping system, e.g. `billing.invoices`. */
  path: string
  /** The `sources` claim the element declares. */
  declared: string
  /**
   * Repository-relative paths of the observed files that resolve to this
   * element, by the same longest-claim ownership the edges use. For a fragment
   * element this is the containing file; the fragment locator is `declared`.
   */
  ownedFiles: string[]
}

/**
 * Propose a description for one drafted element, or `undefined` to keep the
 * TODO. Typed structurally here so the core stays free of `fitc4/agent`; the
 * agent-powered implementation is `draftDescriber` in that entry point.
 */
export type DraftDescribe = (element: DraftElementFacts) => Promise<string | undefined>

export interface DraftOptions {
  /**
   * Tag every emitted relationship as tolerated drift (the default). The
   * first gate run is then green and the drift line counts the debt down;
   * untagging an edge blesses it. `false` emits plain relationships.
   */
  drift?: boolean
  /** The drift tag to declare and apply. Defaults to `DEFAULT_DRIFT_TAG`. */
  driftTag?: string
  /**
   * Replace each eligible element's TODO description with what this callback
   * proposes from the element's own facts. Eligible means a declared `sources`
   * claim plus at least one owned observed file; claimless containers, the
   * boundary elements, and the vendor stub keep their placeholders. Advisory
   * by design: a callback that returns `undefined` or throws keeps the TODO
   * and never fails the draft. Descriptions stay a draft-time proposal, since
   * the gate only ever critiques descriptions, never rewrites them.
   */
  describe?: DraftDescribe
  /**
   * Narration hook, same contract as `PipelineConfig.onProgress`: one plain
   * line per scan provider start and completion, wired to stderr by the CLI.
   */
  onProgress?: Progress
}

export interface DraftResult {
  /** The generated LikeC4 model text. */
  text: string
  /** Absolute path written, or undefined when writing was refused. */
  written?: string
  /** Why the draft was not written, when a model file already exists. */
  refusal?: string
  /** Elements drafted, the vendor stub and boundary elements included. */
  elements: number
  /** Relationships drafted. */
  edges: number
  /** External package names claimed by the stub element. */
  packages: number
  /** Elements offered to the `describe` callback; 0 when none was configured. */
  describeAttempted: number
  /** Elements whose TODO description the callback replaced. */
  described: number
}

/** The extensions LikeC4 treats as model files. */
const MODEL_EXTENSIONS = ['.c4', '.likec4', '.like-c4']

/**
 * Names LikeC4's grammar reserves in the element-name position.
 *
 * Most keywords (`model`, `element`, `component`) are legal element names,
 * but these are not, and a directory named `views` is common enough that the
 * draft must not choke on it. Mangled with a trailing underscore rather than
 * rejected: the id is a draft the human renames anyway.
 */
const RESERVED_NAMES = new Set([
  'views',
  'view',
  'specification',
  'metadata',
  'description',
  'technology',
  'title',
  'style',
  'icon',
  'link',
  'tag',
  'tags',
  'include',
  'exclude',
  'extend',
  'extends',
  'import',
  'dynamic',
  'autoLayout',
  'global',
  'this',
  'it',
])

const TODO_DESCRIPTION = 'TODO: what is this component responsible for?'

/** One drafted element: a directory, a fragment-bearing file, or a fragment. */
interface DraftElement {
  /** The identifier inside its parent scope, assigned after sorting. */
  id: string
  /** The dot-joined identifier path under the wrapping system, for edges. */
  path: string
  /** The element title, the directory, file, or fragment name as observed. */
  name: string
  /**
   * The claim the element matches subjects against: a directory prefix ending
   * in `/`, or a fragment locator. Present without `declared` on a pure
   * container, which owns nothing itself.
   */
  prefix?: string
  /** The `sources` value to declare, when the element claims one. */
  declared?: string
  /** A proposed description from the `describe` callback; TODO otherwise. */
  description?: string
  /** Nested child elements: split subdirectories, files, fragments. */
  children: DraftElement[]
  /** Deterministic ordering key inside the parent scope. */
  sortKey: string
}

/** One boundary element: a dependency target of a non-repository kind. */
interface DraftExternal {
  kind: string
  targetId: string
  elementId: string
}

/**
 * Draft a model from what the configured scan providers observe.
 *
 * Scan providers receive only the repository root, never a model, which is
 * what makes drafting possible at all: draft runs precisely when no model
 * exists yet. A provider that throws aborts the draft loudly. Unlike a gate
 * run there is no report to contain the failure in, and a draft built from
 * half a scan would be a misleading one.
 */
export async function draft(
  config: ResolvedConfig,
  options: DraftOptions = {},
): Promise<DraftResult> {
  const drift = options.drift ?? true
  const driftTag = options.driftTag ?? DEFAULT_DRIFT_TAG
  const narrate = options.onProgress

  // The same narration seams as the pipeline's scan phase, because this IS a
  // scan run: provider start, then done with a count and elapsed time.
  const scanProviders = pipelineConfig(config).scan
  narrate?.(`scan: ${count(scanProviders.length, 'provider')}`)

  const observations: Observation[] = []
  for (const provider of scanProviders) {
    narrate?.(`scan: ${provider.id}...`)
    const started = Date.now()
    const progress: Progress | undefined =
      narrate === undefined ? undefined : (message) => narrate(`${provider.id}: ${message}`)
    try {
      const observed = await provider.run({ repositoryRoot: config.repositoryRoot, progress })
      narrate?.(`scan: ${provider.id} done, ${count(observed.length, 'observation')}, ${elapsed(started)}`)
      observations.push(...observed)
    } catch (error) {
      throw new Error(`scan provider ${provider.id} failed: ${messageOf(error)}`)
    }
  }

  const elements = draftElements(observations, config.scanRoots)
  const packages = observedPackages(observations)
  const externals = observedExternals(observations)

  const taken = new Set<string>()
  finalize(elements, '', taken)
  for (const external of externals) {
    external.elementId = identifier(external.targetId, taken)
  }
  const vendorId = packages.length > 0 ? identifier('vendor', taken) : undefined

  const edges = draftEdges(observations, elements, packages, vendorId, externals)

  const describeCounts = await describeElements(elements, observations, options.describe, narrate)

  const text = render(elements, externals, edges, packages, vendorId, drift ? driftTag : undefined)
  const placement = place(config, text)

  return {
    text,
    ...placement,
    elements: countElements(elements) + externals.length + (vendorId === undefined ? 0 : 1),
    edges: edges.length,
    packages: packages.length,
    ...describeCounts,
  }
}

/**
 * Run the optional describe pass over the eligible drafted elements.
 *
 * Eligibility is having something to describe from: a declared `sources`
 * claim and at least one observed file resolving to it, which covers
 * directory elements, root catch-alls, and fragment elements. Claimless
 * containers have no files of their own, and the boundary and vendor stubs
 * are not `DraftElement`s at all, so none of them are offered. The pass only
 * ever edits description text: claims, structure, and edges are already
 * fixed, so a misbehaving callback cannot change what the draft gates.
 *
 * Advisory throughout: `undefined` and a thrown callback both keep the TODO,
 * narrated but never fatal. A draft with placeholder descriptions is exactly
 * as correct as one without the pass.
 */
async function describeElements(
  elements: DraftElement[],
  observations: Observation[],
  describe: DraftDescribe | undefined,
  narrate: Progress | undefined,
): Promise<{ describeAttempted: number; described: number }> {
  if (describe === undefined) return { describeAttempted: 0, described: 0 }

  const prefixes = claimedPrefixes(elements)
  const owned = new Map<string, Set<string>>()
  for (const observation of observations) {
    if (observation.kind !== 'file' || observation.subject?.kind !== 'file') continue
    const subjectId = observation.subject.id
    const owner = ownerOf(subjectId, prefixes)
    if (owner.status !== 'resolved') continue
    // A fragment subject resolves onto its fragment element, but what the
    // describer can read is the containing file, so the locator is stripped;
    // the fragment itself rides along as the element's declared claim.
    const hash = subjectId.indexOf('#')
    const filePath = hash === -1 ? subjectId : subjectId.slice(0, hash)
    if (!owned.has(owner.elementId)) owned.set(owner.elementId, new Set())
    owned.get(owner.elementId)?.add(filePath)
  }

  const eligible: { element: DraftElement; declared: string; ownedFiles: string[] }[] = []
  const collect = (scope: DraftElement[]): void => {
    for (const element of scope) {
      const files = owned.get(element.path)
      if (element.declared !== undefined && files !== undefined && files.size > 0) {
        eligible.push({ element, declared: element.declared, ownedFiles: [...files].sort() })
      }
      collect(element.children)
    }
  }
  collect(elements)

  narrate?.(`describe: ${count(eligible.length, 'element')}`)

  let described = 0
  for (const { element, declared, ownedFiles } of eligible) {
    narrate?.(`describe: app.${element.path}...`)
    const started = Date.now()
    try {
      const proposed = await describe({ name: element.name, path: element.path, declared, ownedFiles })
      if (proposed !== undefined && proposed.trim() !== '') {
        element.description = proposed.trim()
        described += 1
        narrate?.(`describe: app.${element.path} done, ${elapsed(started)}`)
      } else {
        narrate?.(`describe: app.${element.path} kept the TODO, ${elapsed(started)}`)
      }
    } catch (error) {
      // Advisory tier: the failure is narrated with its cause and the element
      // keeps its TODO, because a describe pass must never fail the draft.
      narrate?.(`describe: app.${element.path} failed, ${messageOf(error)}, ${elapsed(started)}`)
    }
  }

  return { describeAttempted: eligible.length, described }
}

/** All elements in a subtree, the element itself included. */
function countElements(scope: DraftElement[]): number {
  return scope.reduce((sum, element) => sum + 1 + countElements(element.children), 0)
}

/** A directory as the plain file observations reported it. */
interface DirectoryNode {
  directories: Map<string, DirectoryNode>
  /** Whether an observed file sits directly in this directory. */
  hasDirectFiles: boolean
}

function directoryNode(): DirectoryNode {
  return { directories: new Map(), hasDirectFiles: false }
}

/**
 * Derive the element structure from `file` observations, never from the
 * filesystem, so any scan provider feeds it and every emitted claim is
 * guaranteed to match something observed.
 *
 * Each scan root splits into its first-level directories, as it always has:
 * the root is the granularity floor the user already chose, and many real
 * dependency graphs (a services directory, a repository whose only crossings
 * are vendor imports) have nothing to say at that level. Below the first
 * level the observed dependency graph decides: see `buildDirectory`. Files
 * sitting directly in a named scan root get one catch-all element claiming
 * the whole root; a repository-root scan root gets no catch-all, because
 * `sources` may not claim the whole repository. Fragment-bearing file
 * observations become fragment elements under a file element instead of
 * feeding the directory tree; the structure they report is sub-file.
 */
function draftElements(observations: Observation[], scanRoots: string[]): DraftElement[] {
  const roots = [...new Set(scanRoots.map(normalizeRoot))].sort(
    (a, b) => b.length - a.length,
  )

  const plainFiles: string[] = []
  const fragmentFiles = new Map<string, Set<string>>()
  for (const observation of observations) {
    if (observation.kind !== 'file') continue
    if (observation.subject?.kind !== 'file') continue
    const subjectId = observation.subject.id
    const hash = subjectId.indexOf('#')
    if (hash > 0 && hash < subjectId.length - 1) {
      const filePath = subjectId.slice(0, hash)
      const locators = fragmentFiles.get(filePath) ?? new Set<string>()
      locators.add(subjectId)
      fragmentFiles.set(filePath, locators)
    } else if (hash === -1) {
      plainFiles.push(subjectId)
    }
  }

  // The dependency pairs that drive splitting. Fragment endpoints are the
  // fragments' own structure and module or domain-specific targets are not
  // places in the tree, so only plain file-to-file pairs count.
  const dependencyPairs: [string, string][] = []
  for (const observation of observations) {
    if (observation.kind !== 'dependency') continue
    const from = observation.subject?.kind === 'file' ? observation.subject.id : undefined
    const to = observation.target?.kind === 'file' ? observation.target.id : undefined
    if (from === undefined || to === undefined) continue
    if (from.includes('#') || to.includes('#')) continue
    dependencyPairs.push([from, to])
  }

  const trees = new Map<string, DirectoryNode>()
  for (const filePath of plainFiles) {
    const root = roots.find((candidate) => candidate === '' || filePath.startsWith(`${candidate}/`))
    if (root === undefined) continue
    let node: DirectoryNode | undefined = trees.get(root)
    if (node === undefined) {
      node = directoryNode()
      trees.set(root, node)
    }
    const rest = root === '' ? filePath : filePath.slice(root.length + 1)
    const segments = rest.split('/')
    for (const segment of segments.slice(0, -1)) {
      const existing: DirectoryNode | undefined = node.directories.get(segment)
      const child: DirectoryNode = existing ?? directoryNode()
      if (existing === undefined) node.directories.set(segment, child)
      node = child
    }
    node.hasDirectFiles = true
  }

  const topLevel: DraftElement[] = []
  for (const [root, tree] of trees) {
    for (const [name, child] of tree.directories) {
      const base = root === '' ? name : `${root}/${name}`
      topLevel.push(buildDirectory(child, base, name, dependencyPairs))
    }
    if (tree.hasDirectFiles && root !== '') {
      topLevel.push({
        id: '',
        path: '',
        name: root.split('/').at(-1) ?? root,
        prefix: `${root}/`,
        declared: `${root}/**`,
        children: [],
        sortKey: `${root}/`,
      })
    }
  }

  for (const [filePath, locators] of [...fragmentFiles].sort(([a], [b]) => a.localeCompare(b))) {
    attach(topLevel, fileElement(filePath, locators), filePath)
  }

  return topLevel
}

/**
 * Build the element for one directory, splitting or collapsing it.
 *
 * A directory splits into nested child elements when at least one observed
 * dependency crosses between two different subdirectories of it; a file
 * sitting directly in the directory belongs to the directory itself and
 * triggers no split. A directory with no such crossing collapses into a
 * single element claiming its whole subtree, however deep the folders go.
 * A split directory that also holds direct files keeps a `<dir>/**` claim,
 * and longest-prefix ownership hands each subdirectory's files to its child
 * element, so the parent ends up owning exactly its direct files. A split
 * directory without direct files is a pure container with no claim.
 */
function buildDirectory(
  node: DirectoryNode,
  base: string,
  name: string,
  dependencyPairs: [string, string][],
): DraftElement {
  const prefix = `${base}/`
  const element: DraftElement = {
    id: '',
    path: '',
    name,
    prefix,
    children: [],
    sortKey: prefix,
  }

  if (!splits(node, prefix, dependencyPairs)) {
    element.declared = `${base}/**`
    return element
  }

  element.children = [...node.directories].map(([childName, child]) =>
    buildDirectory(child, `${base}/${childName}`, childName, dependencyPairs),
  )
  if (node.hasDirectFiles) element.declared = `${base}/**`
  return element
}

/** Whether an observed dependency crosses between two subdirectories. */
function splits(
  node: DirectoryNode,
  prefix: string,
  dependencyPairs: [string, string][],
): boolean {
  if (node.directories.size < 2) return false
  for (const [from, to] of dependencyPairs) {
    const a = childDirectory(from, prefix, node)
    const b = childDirectory(to, prefix, node)
    if (a !== undefined && b !== undefined && a !== b) return true
  }
  return false
}

/** The observed subdirectory a path falls under, if it falls under one. */
function childDirectory(
  filePath: string,
  prefix: string,
  node: DirectoryNode,
): string | undefined {
  if (!filePath.startsWith(prefix)) return undefined
  const rest = filePath.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return undefined
  const segment = rest.slice(0, slash)
  return node.directories.has(segment) ? segment : undefined
}

/**
 * The element for one fragment-bearing file: a container titled by the file
 * name, one child element per distinct observed fragment. Each fragment
 * claims its full locator verbatim, which `sources` fragment claims support,
 * and the container claims nothing; plain observations on the same file keep
 * resolving to the directory-derived owner.
 */
function fileElement(filePath: string, locators: Set<string>): DraftElement {
  return {
    id: '',
    path: '',
    name: filePath.split('/').at(-1) ?? filePath,
    children: [...locators].sort().map((locator) => ({
      id: '',
      path: '',
      name: fragmentTitle(locator),
      prefix: locator,
      declared: locator,
      children: [],
      sortKey: locator,
    })),
    sortKey: `${filePath}#`,
  }
}

/** A readable title: the last dot-segment of the locator's fragment part. */
function fragmentTitle(locator: string): string {
  const fragment = locator.slice(locator.indexOf('#') + 1)
  return fragment.split('.').at(-1) ?? fragment
}

/** Nest an element under the deepest directory element covering its file. */
function attach(scope: DraftElement[], element: DraftElement, filePath: string): void {
  const parent = scope
    .filter((candidate) => candidate.prefix?.endsWith('/') === true && filePath.startsWith(candidate.prefix))
    .sort((a, b) => (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0))[0]
  if (parent === undefined) {
    scope.push(element)
    return
  }
  attach(parent.children, element, filePath)
}

/** Sort each scope, assign identifiers per level, and derive dotted paths. */
function finalize(scope: DraftElement[], parentPath: string, taken: Set<string>): void {
  scope.sort((a, b) => a.sortKey.localeCompare(b.sortKey))
  for (const element of scope) {
    element.id = identifier(element.name, taken)
    element.path = parentPath === '' ? element.id : `${parentPath}.${element.id}`
    finalize(element.children, element.path, new Set())
  }
}

/** `./src/`, `src\\core`, `src/` all become the same repository-relative root. */
function normalizeRoot(root: string): string {
  const normalized = root
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  return normalized === '.' ? '' : normalized
}

/**
 * The external package names the scan observed, exact and claimable.
 *
 * Node builtins are not packages and stay unclaimed, and anything
 * `toPackageName` would reject is dropped rather than drafted into an
 * `invalid-packages` error.
 */
function observedPackages(observations: Observation[]): string[] {
  const names = new Set<string>()

  for (const observation of observations) {
    if (observation.kind !== 'dependency') continue
    if (observation.target?.kind !== 'module') continue
    const specifier = observation.target.id
    if (isBuiltin(specifier)) continue
    const name = packageNameOf(specifier)
    if (isBuiltin(name)) continue
    if ('reason' in toPackageName(name)) continue
    names.add(name)
  }

  return [...names].sort()
}

/**
 * The boundary targets the scan observed: dependency targets of any kind
 * that is not a repository path (`file`, `directory`) or an npm package
 * (`module`). The scan reply schema allows domain-specific kinds like
 * `system` or `service`, and each distinct kind and id pair becomes one
 * description-only element beside the vendor stub. Unowned `file` targets
 * and `directory` targets stay dropped, as they always were: they name
 * places in this repository, not things beyond it.
 */
function observedExternals(observations: Observation[]): DraftExternal[] {
  const seen = new Map<string, DraftExternal>()

  for (const observation of observations) {
    if (observation.kind !== 'dependency') continue
    const target = observation.target
    if (target === undefined) continue
    if (target.kind === 'file' || target.kind === 'directory' || target.kind === 'module') continue
    if (target.id.trim() === '') continue
    seen.set(`${target.kind} ${target.id}`, {
      kind: target.kind,
      targetId: target.id,
      elementId: '',
    })
  }

  return [...seen.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.targetId.localeCompare(b.targetId),
  )
}

interface DraftEdge {
  from: string
  to: string
  /** How many observed dependencies ride this edge. Informational only. */
  count: number
  /** True when the target is a boundary element the gate cannot resolve. */
  boundary: boolean
}

/**
 * One relationship per distinct cross-element pair, resolved by the same
 * longest-claim ownership the gate will use, so the drafted relationships
 * cover exactly the crossings the gate will observe. Fragment subjects and
 * targets resolve onto fragment elements through the same `ownerOf` call,
 * because fragment claims are longer than any directory prefix covering the
 * same file. A pair nested inside one drafted boundary is no crossing, and
 * LikeC4 refuses to declare it anyway.
 */
function draftEdges(
  observations: Observation[],
  elements: DraftElement[],
  packages: string[],
  vendorId: string | undefined,
  externals: DraftExternal[],
): DraftEdge[] {
  const prefixes = claimedPrefixes(elements)

  const externalIds = new Map(
    externals.map((external) => [`${external.kind} ${external.targetId}`, external.elementId]),
  )
  const claimed = new Set(packages)
  const counts = new Map<string, DraftEdge>()

  const bump = (from: string, to: string, boundary: boolean): void => {
    if (sameOrNestedPath(from, to)) return
    const key = `${from} ${to}`
    const edge = counts.get(key)
    if (edge === undefined) {
      counts.set(key, { from, to, count: 1, boundary })
    } else {
      edge.count += 1
    }
  }

  for (const observation of observations) {
    if (observation.kind !== 'dependency') continue
    const fromPath = observation.subject?.kind === 'file' ? observation.subject.id : undefined
    if (fromPath === undefined) continue
    const from = ownerOf(fromPath, prefixes)
    if (from.status !== 'resolved') continue

    const target = observation.target
    if (target === undefined) continue
    if (target.kind === 'file') {
      const to = ownerOf(target.id, prefixes)
      if (to.status === 'resolved') bump(from.elementId, to.elementId, false)
    } else if (target.kind === 'module') {
      if (vendorId !== undefined && claimed.has(packageNameOf(target.id))) {
        bump(from.elementId, vendorId, false)
      }
    } else if (target.kind !== 'directory') {
      const externalId = externalIds.get(`${target.kind} ${target.id}`)
      if (externalId !== undefined) bump(from.elementId, externalId, true)
    }
  }

  return [...counts.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
}

/** Whether two dotted element paths are the same element or nested. */
function sameOrNestedPath(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

/**
 * Every claiming element's ownership prefix, in `ownerOf` shape, so the edge
 * resolution and the describe pass judge ownership by the exact same rule the
 * gate will.
 */
function claimedPrefixes(
  elements: DraftElement[],
): { elementId: string; prefix: string; declared: string }[] {
  const prefixes: { elementId: string; prefix: string; declared: string }[] = []
  const collect = (scope: DraftElement[]): void => {
    for (const element of scope) {
      if (element.prefix !== undefined && element.declared !== undefined) {
        prefixes.push({ elementId: element.path, prefix: element.prefix, declared: element.declared })
      }
      collect(element.children)
    }
  }
  collect(elements)
  return prefixes
}

/** A LikeC4-safe identifier: sanitized, keyword-mangled, deduplicated. */
function identifier(name: string, taken: Set<string>): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_')
  if (id === '') id = 'unnamed'
  if (/^[0-9]/.test(id)) id = `_${id}`
  if (RESERVED_NAMES.has(id)) id = `${id}_`

  let candidate = id
  for (let ordinal = 2; taken.has(candidate); ordinal += 1) {
    candidate = `${id}_${ordinal}`
  }
  taken.add(candidate)
  return candidate
}

/** Single quotes when possible, double quotes when the value carries one. */
function quoted(value: string): string {
  return value.includes("'") ? `"${value.replace(/"/g, '\\"')}"` : `'${value}'`
}

function renderElement(element: DraftElement, indent: string): string[] {
  const lines = [`${indent}${element.id} = component ${quoted(element.name)} {`]
  lines.push(`${indent}  description ${quoted(element.description ?? TODO_DESCRIPTION)}`)
  if (element.declared !== undefined) {
    lines.push(`${indent}  metadata {`)
    lines.push(`${indent}    sources ${quoted(element.declared)}`)
    lines.push(`${indent}  }`)
  }
  for (const child of element.children) {
    lines.push('')
    lines.push(...renderElement(child, `${indent}  `))
  }
  lines.push(`${indent}}`)
  return lines
}

function render(
  elements: DraftElement[],
  externals: DraftExternal[],
  edges: DraftEdge[],
  packages: string[],
  vendorId: string | undefined,
  driftTag: string | undefined,
): string {
  const lines: string[] = []

  lines.push('specification {')
  lines.push('  element system')
  lines.push('  element component')
  if (driftTag !== undefined) lines.push(`  tag ${driftTag}`)
  lines.push('}')
  lines.push('')
  lines.push('model {')
  lines.push(`  app = system 'App' {`)

  const blocks: string[][] = elements.map((element) => renderElement(element, '    '))

  for (const external of externals) {
    blocks.push([
      `    ${external.elementId} = component ${quoted(external.targetId)} {`,
      `      description ${quoted(`TODO: the scan observed this ${external.kind} only at the boundary; describe what it is.`)}`,
      `    }`,
    ])
  }

  if (vendorId !== undefined) {
    blocks.push([
      `    ${vendorId} = component 'External packages' {`,
      `      description ${quoted('TODO: split these packages onto the elements that stand for them')}`,
      `      metadata {`,
      `        packages [${packages.map(quoted).join(', ')}]`,
      `      }`,
      `    }`,
    ])
  }

  lines.push(blocks.map((block) => block.join('\n')).join('\n\n'))
  lines.push('  }')

  const owned = edges.filter((edge) => !edge.boundary)
  const boundary = edges.filter((edge) => edge.boundary)

  if (owned.length > 0) {
    lines.push('')
    if (driftTag !== undefined) {
      lines.push('  // Every relationship below was observed in the code and is tagged as')
      lines.push('  // tolerated drift. Untag an edge to bless it as intended architecture;')
      lines.push('  // the gate counts the rest down.')
    } else {
      lines.push('  // Every relationship below was observed in the code. Delete what the')
      lines.push('  // architecture does not intend, then fix the code the gate flags.')
    }
    for (const edge of owned) {
      const tag = driftTag === undefined ? '' : ` { #${driftTag} }`
      lines.push(`  app.${edge.from} -> app.${edge.to}${tag} // ${count(edge.count, 'dependency')}`)
    }
  }

  if (boundary.length > 0) {
    lines.push('')
    lines.push('  // Each relationship below reaches something the scan saw only as a')
    lines.push('  // dependency target. The gate resolves nothing onto these boundary')
    lines.push('  // elements yet, so a drift tag would count as unused; they are plain')
    lines.push('  // declared edges to rewrite along with their stub elements.')
    for (const edge of boundary) {
      lines.push(`  app.${edge.from} -> app.${edge.to} // ${count(edge.count, 'dependency')}`)
    }
  }

  lines.push('}')
  lines.push('')
  lines.push('views {')
  lines.push('  view index of app {')
  lines.push('    include *')
  lines.push('  }')
  lines.push('}')

  return `${lines.join('\n')}\n`
}

/**
 * Write the draft, or refuse.
 *
 * Init's never-overwrite rule: any model file already in the configured
 * model directory means the directory is authored territory, and the draft
 * is printed for the human to merge instead of written beside or over it.
 */
function place(
  config: ResolvedConfig,
  text: string,
): { written?: string; refusal?: string } {
  const existing = existingModelFiles(config.modelDir)
  const modelDir = path.relative(config.repositoryRoot, config.modelDir).split(path.sep).join('/')

  if (existing.length > 0) {
    const shown = [modelDir, existing[0]].filter((part) => part !== '').join('/')
    return {
      refusal:
        `${shown} already exists and a draft never overwrites a model, ` +
        `so the draft is printed above instead. Merge it by hand, or point the config's ` +
        `'model' at an empty directory and rerun.`,
    }
  }

  const target = path.join(config.modelDir, MODEL_FILENAME)
  fs.mkdirSync(config.modelDir, { recursive: true })
  fs.writeFileSync(target, text)
  return { written: target }
}

/** Model files under the directory, relative to it, dotfiles and node_modules skipped. */
function existingModelFiles(directory: string): string[] {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return []
  const found: string[] = []

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
      } else if (MODEL_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(path.relative(directory, absolute).split(path.sep).join('/'))
      }
    }
  }

  walk(directory)
  return found.sort()
}
