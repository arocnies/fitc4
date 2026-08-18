export interface OrderLine {
  unitCents: number
  quantity: number
}

export interface Order {
  id: string
  customer: string
  lines: OrderLine[]
}

export function orderTotalCents(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0)
}
