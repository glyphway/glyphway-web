import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __VERSION__: JSON.stringify('1.0.0') },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
  },
})
