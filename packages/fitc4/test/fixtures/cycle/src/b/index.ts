import type { a } from '../a/index.ts'

import { aName } from '../a/name.ts'

export const b = (): string => `b(${aName})`
export type B = typeof a
