/**
 * CurlViz 的 service worker：只做一件事——让本地构建的页面离线可开。
 *
 * 关键约束：SW 的 fetch 事件会拦到**页面发出的所有请求**，包括用户拿本工具去调的内网 API。
 * 那些请求必须原样透传，不能被缓存、也不能被 SW 改写，否则"发送"结果就不是真的了。
 * 所以这里对每个非"同源 + GET + 应用路径内"的请求直接 return，一行 respondWith 都不做。
 */

const CACHE = 'curlviz-v1'
/** 应用外壳：这些齐了就能离线打开页面。带 hash 的产物靠运行时缓存补充。 */
const SHELL = ['./', './index.html', './manifest.webmanifest', './favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  const appPath = new URL('./', self.location.href).pathname
  if (!url.pathname.startsWith(appPath)) return

  // 导航请求：优先联网拿最新，拿不到再回外壳。本地工具改了构建产物却还被旧缓存钉住很难受。
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r ?? caches.match('./')))
    )
    return
  }

  // 带 hash 的静态产物：缓存优先。
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
    )
  )
})
