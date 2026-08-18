// Charges the customer's card through the third-party payments SDK. The
// planted ground truth: `stripe` is claimed by no element's `packages`
// metadata, so this import is a leftover candidate for `agentResolve` with
// exactly one right answer — the payments gateway element.
import Stripe from 'stripe'

export function checkout(orderId: string): string {
  const client = new Stripe('sk_test_fixture')
  return `charged ${orderId} via ${typeof client}`
}
