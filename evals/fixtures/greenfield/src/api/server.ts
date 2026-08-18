import { checkout } from '../core/checkout.js'

export function handleCheckout(orderId: string): string {
  return checkout(orderId)
}
