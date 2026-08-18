/**
 * The message of a thrown value.
 *
 * `catch` receives `unknown`, and most of this package's error paths fold the
 * caught value into a larger message. One helper keeps the Error-versus-thrown
 * -string handling identical everywhere.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
