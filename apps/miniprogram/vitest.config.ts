import { defineConfig } from 'vitest/config'

const runsExplicitE2eFile = process.argv.some((argument) => argument.includes('test/e2e/'))

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      'dist/**',
      'node_modules/**',
      ...(runsExplicitE2eFile ? [] : ['test/e2e/**', 'apps/miniprogram/test/e2e/**']),
    ],
  },
})
