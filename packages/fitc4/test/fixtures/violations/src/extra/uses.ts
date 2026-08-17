import { health } from '../core/health.js'

export function check(): 'ok' {
  return health()
}
