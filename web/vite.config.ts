import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * base 用相对路径：交付形态是"dist 目录双击 index.html 或任意静态托管"，
 * 写死 '/' 会让子目录部署（GH Pages 之类）资源全 404。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    // 响应预览走 iframe sandbox，不引第三方 UI 库，产物应当很小；超了就当信号查依赖
    chunkSizeWarningLimit: 400
  },
  server: {
    port: 5183,
    strictPort: true
  }
})
