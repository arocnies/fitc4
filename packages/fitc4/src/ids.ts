/**
 * Stable identifiers.
 *
 * LikeC4 mints relationship ids as generated hashes (`g8faux`), which churn
 * across unrelated model edits and are meaningless in a report. Every
 * identifier the pipeline reports is derived from author-controlled names
 * instead, so it changes only when someone renames a component.
 */

/** `acme.app.iface::imports::acme.app.core` */
export function relationshipId(
  sourceId: string,
  targetId: string,
  kind?: string | null,
): string {
  return `${sourceId}::${kind ?? '_'}::${targetId}`
}

export function findingId(provider: string, ruleId: string, subjectKey: string): string {
  return `${provider}/${ruleId}/${subjectKey}`
}

/**
 * Namespace an id with its emitting provider so two providers cannot collide
 * on a natural key such as `file:src/index.ts`.
 */
export function namespaced(provider: string, id: string): string {
  return id.startsWith(`${provider}/`) ? id : `${provider}/${id}`
}
