import { expect, test } from 'vitest'
import { status } from './index.js'

test('the interface reports the starter as ready', () => {
  expect(status()).toBe('ok')
})
