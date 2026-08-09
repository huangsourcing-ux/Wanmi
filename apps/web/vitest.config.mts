import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'node',
    globals: true,
    hookTimeout: 60_000,
    restoreMocks: true,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 90_000,
  },
})
