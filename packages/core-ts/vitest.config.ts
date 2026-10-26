import { defineConfig } from 'vitest/config'

/**
 * 内核包单独可跑（`npm run test --workspace @curlviz/core`），
 * 同时被根 vitest.config.ts 的 projects 收编。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
