// Every reference to core in this component is erased at compile time, in all
// three type-only forms: a type-only clause, all-type-only specifiers, and a
// type-only re-export. The interface -> core edge is purely type-only.
import type { Status } from '../core/health.js'
import { type Shape } from '../core/health.js'

export type { Status as CoreStatus } from '../core/health.js'

export function describe(shape: Shape): Status {
  return shape.status
}
