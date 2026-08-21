/**
 * The shared vocabulary between providers.
 *
 * `Observation.kind` and `Ref.kind` are the one contract that crosses provider
 * boundaries: a scan provider emitting `import` where the rules look for
 * `dependency` produces no findings and a clean exit, precisely the fail-open
 * this project exists to prevent. Left as bare string literals in two files,
 * that contract is invisible until a second scanner gets it wrong.
 *
 * Kinds stay open. A provider may emit its own, and two providers that
 * understand each other's private kinds may cooperate without asking anyone.
 * What the standard set buys is a default that works: emit these and the
 * standard rules understand you.
 */

/**
 * What kind of fact an `Observation` records.
 *
 * These are deliberately about evidence, not about any one language. A call
 * graph, an HTTP client, and an import statement all produce `dependency`.
 */
export const OBSERVATION_KINDS = [
  /** A source file exists and is in scope for ownership. */
  'file',
  /**
   * One thing depends on another. `subject` depends on `target`.
   *
   * A scanner that can tell may set `data.typeOnly: true` when the dependency
   * is erased at compile time, like a TypeScript type-only import. This is
   * the one `data` field the standard rules read; absent or false means a
   * runtime dependency.
   */
  'dependency',
  /**
   * A dependency whose target could not be resolved.
   *
   * Separate from `dependency` because the two demand different rules: an
   * unresolvable target cannot be checked against the model at all, and
   * silence there would let a renamed file quietly remove a boundary crossing.
   */
  'unresolved-dependency',
  /**
   * A path the provider actually looked at.
   *
   * The coverage attestation. Rules that judge the model against the code need
   * to know what the code sample was, or they blame the model for a thin scan.
   */
  'scan-root',
] as const

export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

/**
 * What kind of thing a `Ref.id` points at.
 *
 * Three families: the model, the repository, and the pipeline itself.
 */
export const REF_KINDS = [
  // --- the model ---
  /**
   * A LikeC4 element, whatever its C4 kind.
   *
   * Not `component`: an element that owns `sources` may just as well be a
   * container, and copying the C4 kind here would duplicate the model, then
   * eventually contradict it. Ask the model when the specific kind matters.
   */
  'element',
  /** A declared relationship, by its stable derived id. */
  'relationship',

  // --- the repository ---
  /** A source file, as a repository-relative POSIX path. */
  'file',
  /** A directory, as a repository-relative POSIX path. */
  'directory',
  /**
   * A module specifier as written, like `@acme/lib` or `./sibling`.
   *
   * Whether it resolved is a property of the observation, not of the id, so
   * there is no separate `unresolved` ref kind.
   */
  'module',
  /** A named declaration inside a file. Reserved; nothing emits it yet. */
  'symbol',

  // --- the pipeline ---
  /** An earlier `Observation`, by id. */
  'observation',
  /** A provider, by the id it was composed under. */
  'provider',
] as const

export type RefKind = (typeof REF_KINDS)[number]

const STANDARD_OBSERVATION_KINDS: ReadonlySet<string> = new Set(OBSERVATION_KINDS)

/** Whether the standard rules know how to interpret this observation kind. */
export function isStandardObservationKind(kind: string): kind is ObservationKind {
  return STANDARD_OBSERVATION_KINDS.has(kind)
}
