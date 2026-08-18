import { discountedCents } from '../core/pricing.js'

export function syncDiscountColumn(totalCents: number): number {
  return discountedCents(totalCents, 10)
}
