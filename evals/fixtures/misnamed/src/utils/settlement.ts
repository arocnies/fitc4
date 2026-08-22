import { authorize, type Principal } from '../cache/guard.js'
import { postEntry } from './ledger.js'

export interface Payment {
  id: string
  amountMinor: number
  currency: string
}

/**
 * Settle one payment: check that the principal may, move the money, and post
 * the matching ledger entry. This is the only path by which a payment becomes
 * final.
 */
export function settlePayment(principal: Principal, payment: Payment): void {
  authorize(principal, 'payment.settle')
  postEntry({
    paymentId: payment.id,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    postedAt: new Date().toISOString(),
  })
}

/** Reverse a settled payment by posting its opposite entry. */
export function refundPayment(principal: Principal, payment: Payment): void {
  authorize(principal, 'payment.refund')
  postEntry({
    paymentId: payment.id,
    amountMinor: -payment.amountMinor,
    currency: payment.currency,
    postedAt: new Date().toISOString(),
  })
}
