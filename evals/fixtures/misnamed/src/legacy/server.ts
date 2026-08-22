import { authorize, Forbidden, type Principal } from '../cache/guard.js'
import { balanceMinor } from '../utils/ledger.js'
import { refundPayment, settlePayment, type Payment } from '../utils/settlement.js'

export interface Request {
  path: string
  principal: Principal
  payment: Payment
}

export interface Response {
  status: number
  body?: string
}

const ROUTES: Record<string, (request: Request) => string | undefined> = {
  '/payments/settle': (request) => {
    settlePayment(request.principal, request.payment)
    return undefined
  },
  '/payments/refund': (request) => {
    refundPayment(request.principal, request.payment)
    return undefined
  },
  '/ledger/balance': (request) => {
    authorize(request.principal, 'ledger.read')
    return String(balanceMinor(request.payment.currency))
  },
}

/** Route one request and turn a refusal into a 403 rather than a crash. */
export function handle(request: Request): Response {
  const route = ROUTES[request.path]
  if (route === undefined) return { status: 404 }
  try {
    const body = route(request)
    return body === undefined ? { status: 200 } : { status: 200, body }
  } catch (error) {
    if (error instanceof Forbidden) return { status: 403 }
    throw error
  }
}

/**
 * The process entry point. Every request this service serves arrives through
 * `handle` above, and this is the only `main` in the codebase.
 */
export function main(): void {
  process.stdout.write(`serving ${Object.keys(ROUTES).length} routes\n`)
}

main()
