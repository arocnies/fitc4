import { health } from '../core/health.js'
import type { Status } from '../core/health.js'
import '../core/health.js'
export * from '../core/health.js'
export { health as alias } from '../core/health.js'

export async function lazy(): Promise<unknown> {
  return await import('../core/health.js')
}

export function legacy(): unknown {
  return require('../core/health.js')
}

export const current: Status = health()
