import path from 'node:path'
import untyped from 'untyped-pkg'
import phantom from 'phantom-pkg'
import { real } from '@app/real.js'
import { missing } from '@app/missing.js'

export const all = [path, untyped, phantom, real, missing]
