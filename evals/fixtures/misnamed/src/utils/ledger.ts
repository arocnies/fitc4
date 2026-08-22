export interface LedgerEntry {
  paymentId: string
  amountMinor: number
  currency: string
  postedAt: string
}

const entries: LedgerEntry[] = []

/**
 * Append one immutable record of money moved. Entries are never rewritten.
 *
 * The entry is copied and frozen on the way in, so a caller that keeps and
 * mutates its own object cannot rewrite history after the fact. The first
 * live run of this fixture is why: the reviewer noticed that storing the
 * caller's reference made the immutability this comment claims untrue.
 */
export function postEntry(entry: LedgerEntry): void {
  entries.push(Object.freeze({ ...entry }))
}

/** The sum of every posted entry in one currency, in minor units. */
export function balanceMinor(currency: string): number {
  return entries
    .filter((entry) => entry.currency === currency)
    .reduce((total, entry) => total + entry.amountMinor, 0)
}
