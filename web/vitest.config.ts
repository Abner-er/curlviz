import { defineConfig } from 'vitest/config'

/**
 * 浏览器侧逻辑（发送、响应分类、本地存储）都是纯函数 + 可注入依赖，
 * 所以这里用 node 环境跑，不装 jsdom：少一个依赖，少一类装不动的坑。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
