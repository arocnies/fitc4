// A type-only crossing against a relationship the model declares in the
// opposite direction: relationship-direction on a purely type-only edge.
import type { Status } from '../core/health.js'

export const reversedStatus: Status = 'ok'
