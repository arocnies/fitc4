import { b } from '../b/index.ts'
import { c } from '../c/index.ts'

export const a = (): string => `a(${b()}${c()})`
