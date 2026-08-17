import { health } from '../core/health.js'

export function status(): 'ok' {
  return health()
}
