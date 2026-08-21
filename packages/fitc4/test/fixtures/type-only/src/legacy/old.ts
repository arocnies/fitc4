// The only traffic on the drift-tagged legacy -> core relationship, and it is
// type-only. Under typeOnlyImports: 'ignore' the drift edge counts as unused.
import type { Status } from '../core/health.js'

export const oldStatus: Status = 'ok'
