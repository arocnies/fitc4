import { rolesAllowedTo } from './policy.js'

export interface Principal {
  id: string
  roles: string[]
}

/** Thrown when a principal holds no role permitted to perform the action. */
export class Forbidden extends Error {
  constructor(action: string) {
    super(`principal is not permitted to ${action}`)
  }
}

/**
 * Decide whether `principal` may perform `action`, and refuse otherwise.
 *
 * Every caller passes through here before acting. A refused request throws
 * and never reaches the code behind this check.
 */
export function authorize(principal: Principal, action: string): void {
  const allowed = rolesAllowedTo(action)
  if (!principal.roles.some((role) => allowed.includes(role))) {
    throw new Forbidden(action)
  }
}
