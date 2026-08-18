export function discountedCents(totalCents: number, percent: number): number {
  return Math.round(totalCents * (1 - percent / 100))
}

export function taxCents(totalCents: number, rate: number): number {
  return Math.round(totalCents * rate)
}
