// String formatting used by the view layer.
export function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function moneyLabel(totalCents: number): string {
  return `$${(totalCents / 100).toFixed(2)}`
}
