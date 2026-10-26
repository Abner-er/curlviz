import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root 容器不见了，index.html 被动过了？')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

/**
 * SW 只在 http/https 下注册：file:// 打开时既不合法也没意义（离线可用性是"部署成静态站点"才需要的能力）。
 * 注册失败不影响功能，页面本身已经是静态资源。
 */
if (('serviceWorker' in navigator && location.protocol === 'https:') || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 离线能力而已，不成也不弹错吓person */
    })
  })
}
