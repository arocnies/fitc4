import { fetchOrder } from '../api/client.js'

export function orderChangedMessage(orderId: string): string {
  const order = fetchOrder(orderId)
  return `order ${order.id} for ${order.customer} changed`
}
