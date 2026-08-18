import { orderTotalCents, type Order } from '../core/orders.js'

export function fetchOrder(orderId: string): Order & { totalCents: number } {
  const order: Order = { id: orderId, customer: 'ada lovelace', lines: [{ unitCents: 1250, quantity: 2 }] }
  return { ...order, totalCents: orderTotalCents(order) }
}
