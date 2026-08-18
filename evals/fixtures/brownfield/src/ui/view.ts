import { fetchOrder } from '../api/client.js'
import { moneyLabel, titleCase } from '../render-helpers.js'

export function renderOrder(orderId: string): string {
  const order = fetchOrder(orderId)
  return `${titleCase(order.customer)} — ${moneyLabel(order.totalCents)}`
}
