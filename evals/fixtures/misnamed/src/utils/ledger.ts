export interface LedgerEntry {
  paymentId: string
  amountMinor: number
  currency: string
  postedAt: string
}

const entries: LedgerEntry[] = []

/** Append one immutable record of money moved. Entries are never rewritten. */
export function postEntry(entry: LedgerEntry): void {
  entries.push(entry)
}

/** The sum of every posted entry in one currency, in minor units. */
export function balanceMinor(currency: string): number {
  return entries
    .filter((entry) => entry.currency === currency)
    .reduce((total, entry) => total + entry.amountMinor, 0)
}
