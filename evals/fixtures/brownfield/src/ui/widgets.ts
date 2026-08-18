import { moneyLabel } from '../render-helpers.js'

export function priceBadge(totalCents: number): string {
  return `<span class="badge">${moneyLabel(totalCents)}</span>`
}
