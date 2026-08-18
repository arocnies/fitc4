import { orderTotalCents, type Order } from '../core/orders.js'

export function legacyOrderRow(orderId: string): string {
  const order: Order = { id: orderId, customer: 'legacy', lines: [] }
  return `${orderId}|${orderTotalCents(order)}`
}
