import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The fixture projects contain files named like tests (they exercise the
    // scanner's test-file exclusion); only this package's own suite runs.
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**'],
  },
})
