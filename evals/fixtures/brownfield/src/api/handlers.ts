import { fetchOrder } from './client.js'
import { legacyOrderRow } from '../legacy/model.js'

export function orderHandler(orderId: string): string {
  const order = fetchOrder(orderId)
  // Still backed by the legacy table until the migration completes.
  const row = legacyOrderRow(orderId)
  return JSON.stringify({ ...order, legacyRow: row })
}
