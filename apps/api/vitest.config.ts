import { defineConfig } from 'vitest/config'

const runsExplicitE2eFile = process.argv.some((argument) => argument.includes('test/e2e/'))

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      'dist/**',
      'node_modules/**',
      ...(runsExplicitE2eFile ? [] : ['test/e2e/**', 'apps/api/test/e2e/**']),
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
