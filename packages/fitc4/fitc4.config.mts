import { architectureRules, defineConfig, sourceRoot, typescriptImports } from '@arocnies/fitc4'

export default defineConfig({
  version: 1,
  repositoryRoot: '.',
  model: 'arch',
  scan: [typescriptImports({ tsconfig: 'tsconfig.json', roots: ['src'] })],
  resolve: [sourceRoot()],
  validate: [architectureRules()],
})
