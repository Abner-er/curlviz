import { createServer as httpCreateServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseConfig, type AgentConfig } from './config'
import { checkAccess } from './gate'
import { createRateLimiter, createSemaphore, type RateLimiter, type Semaphore } from './limits'
import { runCurl } from './curl-runner'
import { failure, type WireResponse } from './wire'

/**
 * /exec 的 HTTP 外壳。把已受测的纯层（config/gate/ssrf/curl-runner）串起来：
 *   路由 → 速率 → 请求体上限 → JSON → checkAccess(Origin/token/契约/SSRF) → 并发 → runCurl。
 * 红线：只留脱敏审计（谁/何时/目标 host/结果/耗时），绝不落请求体或响应体。
 */

interface Ctx {
  cfg: AgentConfig
  rate: RateLimiter
  sem: Semaphore
}

/** 脱敏审计：一行 JSON，含目标 host 但绝不含路径 query（可能带 token）、绝不含 body。 */
function audit(ev: string, fields: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), ev, ...fields }
  console.log(JSON.stringify(line))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

/** 尽力取目标 host 供审计（失败给 '?'）；只到 host，不带 path/query。 */
function hostForAudit(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `//${url}`).host
  } catch {
    return '?'
  }
}

function readBody(req: IncomingMessage, cap: number): Promise<{ ok: true; text: string } | { ok: false; response: WireResponse }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversize = false
    // 超限后停止存储但继续把流读完（不 destroy）——过早断连会让 413 响应送不出去。
    req.on('data', (c: Buffer) => {
      size += c.length
      if (oversize) return
      if (size > cap) {
        oversize = true
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (oversize) {
        resolve({
          ok: false,
          response: failure('agent-rejected', `请求体超过上限 ${String(cap)} 字节。`, '这条 spec 的 body 太大；agent 为保护内存拒绝整包接收。')
        })
        return
      }
      resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () =>
      resolve({ ok: false, response: failure('agent-error', '读取请求体时连接中断。', '客户端可能提前断开，重试。') })
    )
  })
}

async function handleExec(req: IncomingMessage, res: ServerResponse, ctx: Ctx, startedAt: number): Promise<void> {
  const ip = req.socket.remoteAddress ?? '?'

  // 速率（整体请求量）——在起 curl 前先挡洪水。
  if (!ctx.rate.allow()) {
    audit('rate-limit', { ip })
    sendJson(res, 429, {
      ok: false,
      failure: { kind: 'agent-error', message: `超过速率上限 ${String(ctx.cfg.ratePerMinute)}/min。`, hint: '放慢发送节奏，或调大 CURLVIZ_RATE_PER_MIN。' }
    })
    return
  }

  const body = await readBody(req, ctx.cfg.maxBodyBytes)
  if (!body.ok) {
    audit('body-too-large', { ip })
    sendJson(res, 413, body.response)
    return
  }

  let json: unknown
  try {
    json = JSON.parse(body.text) as unknown
  } catch {
    sendJson(res, 400, { ok: false, failure: { kind: 'agent-rejected', message: '请求体不是合法 JSON。', hint: 'Content-Type 用 application/json，body 是 {"v":1,"spec":…}。' } })
    return
  }

  const origin = (req.headers['origin'] as string | undefined) ?? undefined
  const token = (req.headers['x-curlviz-token'] as string | undefined) ?? undefined
  const access = checkAccess(json, { origin, token }, ctx.cfg)
  if (!access.allow) {
    audit('rejected', { ip, status: access.status, kind: access.response.failure.kind })
    sendJson(res, access.status, access.response)
    return
  }

  // 并发（真正在跑的 curl 进程数）——只有过完闸门才占坑。
  if (!ctx.sem.tryAcquire()) {
    audit('busy', { ip, active: ctx.sem.active() })
    sendJson(res, 429, {
      ok: false,
      failure: { kind: 'agent-error', message: `并发已满（上限 ${String(ctx.cfg.maxConcurrency)} 条 curl 同时在跑）。`, hint: '稍后重发，或调大 CURLVIZ_MAX_CONCURRENCY。' }
    })
    return
  }

  const host = hostForAudit(access.spec.url)
  try {
    const result = await runCurl(access.spec, {
      maxTimeMs: ctx.cfg.maxTimeMs,
      maxPreviewBytes: ctx.cfg.maxPreviewBytes
    })
    audit('exec', {
      ip,
      host,
      ok: result.ok,
      status: result.ok ? result.response.status : result.failure.kind,
      durMs: Date.now() - startedAt
    })
    // 成功与 curl 侧失败都用 200：wire 的 ok:false 已能表达，前端统一渲染（HTTP 层不二次编码失败种类）。
    sendJson(res, 200, result)
  } finally {
    ctx.sem.release()
  }
}

export function createAgentServer(cfg: AgentConfig): ReturnType<typeof httpCreateServer> {
  const ctx: Ctx = { cfg, rate: createRateLimiter(cfg.ratePerMinute), sem: createSemaphore(cfg.maxConcurrency) }

  return httpCreateServer((req, res) => {
    const startedAt = Date.now()
    const method = req.method ?? 'GET'
    const url = req.url ?? ''

    if (method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'curlviz-agent' })
      return
    }
    if (method === 'POST' && url === '/exec') {
      const ct = (req.headers['content-type'] as string | undefined) ?? ''
      if (!ct.toLowerCase().includes('application/json')) {
        sendJson(res, 415, { ok: false, failure: { kind: 'agent-rejected', message: 'Content-Type 需为 application/json。', hint: '按 §13.1 用 JSON 发 {"v":1,"spec":…}。' } })
        return
      }
      void handleExec(req, res, ctx, startedAt).catch((e: unknown) => {
        audit('handler-error', { err: String(e) })
        if (!res.headersSent) sendJson(res, 500, { ok: false, failure: { kind: 'agent-error', message: 'agent 内部错误。', hint: '看 agent 进程日志定位。' } })
      })
      return
    }
    sendJson(res, 404, { ok: false, failure: { kind: 'agent-rejected', message: '只支持 POST /exec 与 GET /healthz。', hint: '确认 baseUrl 指向 agent 根地址，前端会拼 /exec。' } })
  })
}

/** 入口：读环境变量、起监听。 */
export function startAgent(): ReturnType<typeof httpCreateServer> {
  const cfg = parseConfig(process.env)
  const server = createAgentServer(cfg)
  server.listen(cfg.port, () => {
    audit('listen', {
      port: cfg.port,
      tokenRequired: cfg.token !== null,
      origins: cfg.allowedOrigins.length,
      allowRules: cfg.allowlist.length,
      maxTimeMs: cfg.maxTimeMs,
      maxConcurrency: cfg.maxConcurrency,
      ratePerMinute: cfg.ratePerMinute
    })
    if (cfg.allowlist.length === 0) {
      console.warn('[curlviz-agent] allowlist 为空：除硬禁外没有任何目标会被放行。用 CURLVIZ_ALLOW 配放行名单。')
    }
  })
  return server
}

// 仅在作为脚本运行时自启。注意 `vite-node src/server.ts` 下 process.argv[1] 是 vite-node
// 自己的二进制、目标文件在别的参数里，所以不能只测 argv[1]——扫整个 argv 找 server 目标。
// 被 import（如将来集成测）时不自启。
const invokedAsScript = process.argv.some((a) => /src[\\/]server\.(ts|js)$/.test(a))
if (invokedAsScript) startAgent()
