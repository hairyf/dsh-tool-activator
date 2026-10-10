import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['src/*.test.ts', 'test/**/*.test.ts'],
          testTimeout: 10000,
          hookTimeout: 20000,
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['src/client/**/*.test.{ts,tsx}'],
          testTimeout: 10000,
          hookTimeout: 20000,
        },
      },
    ],
  },
})
