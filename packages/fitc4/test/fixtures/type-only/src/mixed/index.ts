// A mixed import keeps a runtime binding, so the mixed -> core edge is a
// value edge no matter how many type-only references sit beside it.
import { type Shape, health } from '../core/health.js'
// An empty import clause still executes the module, so it is a value import.
import {} from '../core/health.js'

export function current(): Shape {
  return { status: health() }
}
