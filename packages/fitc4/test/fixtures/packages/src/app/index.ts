// A subpath import of a claimed package: the claim gates the whole package.
import pool from 'pg/promises'
// Declared in the model: app -> cloud.
import s3 from '@aws-sdk/client-s3'
// Unclaimed by any element: unrestricted.
import merge from 'lodash'

export const wired = [pool, s3, merge]
