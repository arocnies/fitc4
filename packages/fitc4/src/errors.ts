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

/** The known name within edit distance 2, if any. Enough for the typo case. */
export function closestName(key: string, candidates: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined
  for (const name of candidates) {
    const distance = editDistance(key.toLowerCase(), name.toLowerCase())
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name, distance }
    }
  }
  return best?.name
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] ?? 0
      row[j] = Math.min(
        current + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length] ?? 0
}
