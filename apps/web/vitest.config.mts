import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'node',
    globals: true,
    restoreMocks: true,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30_000,
  },
})
