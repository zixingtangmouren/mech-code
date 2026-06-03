import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@mech-code/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@mech-code/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@mech-code/tools': resolve(__dirname, 'packages/tools/src/index.ts'),
      '@mech-code/middleware': resolve(__dirname, 'packages/middleware/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**'],
      exclude: ['packages/*/src/types/**'],
    },
  },
})
