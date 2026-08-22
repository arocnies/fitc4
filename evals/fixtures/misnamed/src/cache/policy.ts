/** Which roles may perform which action. The single source of truth. */
const PERMISSIONS: Record<string, string[]> = {
  'payment.settle': ['treasury', 'admin'],
  'payment.refund': ['admin'],
  'ledger.read': ['treasury', 'auditor', 'admin'],
}

/** The roles permitted to perform `action`; empty means nobody may. */
export function rolesAllowedTo(action: string): string[] {
  return PERMISSIONS[action] ?? []
}
