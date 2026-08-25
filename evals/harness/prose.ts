/**
 * Subtracting a clause from a fixture's instructions, safely.
 *
 * Several fixtures write prose that is not a domain fact but a workaround:
 * a named exemption, a path the context cannot show, a format rule the
 * shipped prompt leaves implicit. An angle that removes one of those measures
 * whether the product needs it, so the removal has to be exact, and it has to
 * fail loudly rather than quietly become a duplicate of the base run.
 *
 * `without` deletes a clause and throws when the clause is not there. The
 * throw is the point: the day someone rewords the base instructions, an angle
 * built on the old wording stops silently scoring the same wiring twice and
 * says so instead.
 */

/** Delete `clause` from `text`, collapsing the space it leaves behind. */
export function without(text: string, clause: string, label: string): string {
  if (!text.includes(clause)) {
    throw new Error(
      `the '${label}' angle subtracts a clause its fixture no longer contains: ` +
        `'${clause.slice(0, 80)}…'. Re-derive the angle from the current instructions`,
    )
  }
  return text.replace(clause, '').replace(/ {2,}/g, ' ').replace(/ \./g, '.').trim()
}
