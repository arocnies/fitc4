/**
 * `fitc4 draft`: bootstrap a first LikeC4 model from the code that exists.
 *
 * Runs the configured scan providers, with no model loaded, and turns what
 * they observed into a first-draft model: one element per first-level
 * directory under each scan root, one relationship per distinct cross-element
 * dependency, and one stub element claiming every observed external package.
 * It consumes observations, not TypeScript specifics, so any scan provider
 * feeds it, dependency-cruiser and agent scanners included.
 *
 * The draft is a starting point the human rewrites, never a sync. Every
 * relationship is tagged as tolerated drift by default, so the very first
 * gate run is green and the drift line becomes the adoption burn-down;
 * untagging an edge is the human act of blessing it as intended architecture.
 *
 * Elements and edges derive from observations, not from the filesystem, so
 * every emitted `sources` prefix matches a scanned file and every emitted
 * relationship covers an observed dependency. The draft therefore cannot
 * produce `unmatched-sources`, `unmatched-packages`, or `unused-drift`
 * findings against itself: the generated model gates green by construction.
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
import { count } from './report.ts'
import type { Observation } from './types.ts'

export interface DraftOptions {
  /**
   * Tag every emitted relationship as tolerated drift (the default). The
   * first gate run is then green and the drift line counts the debt down;
   * untagging an edge blesses it. `false` emits plain relationships.
   */
  drift?: boolean
  /** The drift tag to declare and apply. Defaults to `DEFAULT_DRIFT_TAG`. */
  driftTag?: string
}

export interface DraftResult {
  /** The generated LikeC4 model text. */
  text: string
  /** Absolute path written, or undefined when writing was refused. */
  written?: string
  /** Why the draft was not written, when a model file already exists. */
  refusal?: string
  /** Elements drafted, the package stub included. */
  elements: number
  /** Relationships drafted. */
  edges: number
  /** External package names claimed by the stub element. */
  packages: number
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

/** One drafted element: a first-level directory, or a scan root's own files. */
interface DraftElement {
  /** The child identifier inside the wrapping system. */
  id: string
  /** The element title, the directory name as observed. */
  name: string
  /** The ownership prefix, ending in `/`, for longest-prefix resolution. */
  prefix: string
  /** The `sources` value to declare, `<prefix>**`. */
  declared: string
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

  const observations: Observation[] = []
  for (const provider of pipelineConfig(config).scan) {
    try {
      observations.push(...(await provider.run({ repositoryRoot: config.repositoryRoot })))
    } catch (error) {
      throw new Error(`scan provider ${provider.id} failed: ${messageOf(error)}`)
    }
  }

  const elements = draftElements(observations, config.scanRoots)
  const packages = observedPackages(observations)

  const taken = new Set<string>()
  for (const element of elements) {
    element.id = identifier(element.name, taken)
  }
  const vendorId = packages.length > 0 ? identifier('vendor', taken) : undefined

  const edges = draftEdges(observations, elements, packages, vendorId)

  const text = render(elements, edges, packages, vendorId, drift ? driftTag : undefined)
  const placement = place(config, text)

  return {
    text,
    ...placement,
    elements: elements.length + (vendorId === undefined ? 0 : 1),
    edges: edges.length,
    packages: packages.length,
  }
}

/**
 * One element per first-level directory under each scan root, derived from
 * `file` observations rather than the filesystem so any scan provider works
 * and every emitted prefix is guaranteed to match a scanned file. Files
 * sitting directly in a scan root get one catch-all element claiming the
 * whole root; longest-prefix ownership still hands every subdirectory's
 * files to their own element.
 */
function draftElements(observations: Observation[], scanRoots: string[]): DraftElement[] {
  const roots = [...new Set(scanRoots.map(normalizeRoot))].sort(
    (a, b) => b.length - a.length,
  )
  const byPrefix = new Map<string, DraftElement>()

  for (const observation of observations) {
    if (observation.kind !== 'file') continue
    const filePath = observation.subject?.kind === 'file' ? observation.subject.id : undefined
    if (filePath === undefined) continue

    const root = roots.find((candidate) => candidate === '' || filePath.startsWith(`${candidate}/`))
    if (root === undefined) continue

    const rest = root === '' ? filePath : filePath.slice(root.length + 1)
    const slash = rest.indexOf('/')

    if (slash === -1) {
      // A file directly in the scan root. A repository-root scan root cannot
      // get a catch-all: `sources` may not claim the whole repository.
      if (root === '') continue
      const prefix = `${root}/`
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, {
          id: '',
          name: root.split('/').at(-1) ?? root,
          prefix,
          declared: `${root}/**`,
        })
      }
      continue
    }

    const directory = rest.slice(0, slash)
    const base = root === '' ? directory : `${root}/${directory}`
    const prefix = `${base}/`
    if (!byPrefix.has(prefix)) {
      byPrefix.set(prefix, { id: '', name: directory, prefix, declared: `${base}/**` })
    }
  }

  return [...byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix))
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

interface DraftEdge {
  from: string
  to: string
  /** How many observed dependencies ride this edge. Informational only. */
  count: number
}

/**
 * One relationship per distinct cross-element pair, resolved by the same
 * longest-prefix ownership the gate will use, so the drafted relationships
 * cover exactly the crossings the gate will observe.
 */
function draftEdges(
  observations: Observation[],
  elements: DraftElement[],
  packages: string[],
  vendorId: string | undefined,
): DraftEdge[] {
  const prefixes = elements.map((element) => ({
    elementId: element.id,
    prefix: element.prefix,
    declared: element.declared,
  }))
  const claimed = new Set(packages)
  const counts = new Map<string, DraftEdge>()

  const bump = (from: string, to: string): void => {
    if (from === to) return
    const key = `${from} ${to}`
    const edge = counts.get(key)
    if (edge === undefined) {
      counts.set(key, { from, to, count: 1 })
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

    if (observation.target?.kind === 'file') {
      const to = ownerOf(observation.target.id, prefixes)
      if (to.status === 'resolved') bump(from.elementId, to.elementId)
    } else if (observation.target?.kind === 'module' && vendorId !== undefined) {
      if (claimed.has(packageNameOf(observation.target.id))) bump(from.elementId, vendorId)
    }
  }

  return [...counts.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
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

function render(
  elements: DraftElement[],
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

  const blocks: string[][] = elements.map((element) => [
    `    ${element.id} = component ${quoted(element.name)} {`,
    `      description ${quoted(TODO_DESCRIPTION)}`,
    `      metadata {`,
    `        sources ${quoted(element.declared)}`,
    `      }`,
    `    }`,
  ])

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

  if (edges.length > 0) {
    lines.push('')
    if (driftTag !== undefined) {
      lines.push('  // Every relationship below was observed in the code and is tagged as')
      lines.push('  // tolerated drift. Untag an edge to bless it as intended architecture;')
      lines.push('  // the gate counts the rest down.')
    } else {
      lines.push('  // Every relationship below was observed in the code. Delete what the')
      lines.push('  // architecture does not intend, then fix the code the gate flags.')
    }
    for (const edge of edges) {
      const tag = driftTag === undefined ? '' : ` { #${driftTag} }`
      lines.push(`  app.${edge.from} -> app.${edge.to}${tag} // ${count(edge.count, 'dependency')}`)
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
