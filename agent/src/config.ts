import { parseAllowlist, type AllowRule } from './ssrf'

/**
 * agent 运行配置。全部来自环境变量（部署时经反代/系统注入），解析是纯函数——
 * 好单测，也保证"没配 = 安全默认"而不是"没配 = 全放行"。
 */
export interface AgentConfig {
  port: number
  /** null = 不设自己的 token（挡在 OIDC/mTLS 反代后面时的决策③）。设了就必须逐字匹配。 */
  token: string | null
  /** Origin 白名单（小写）。非空时逐字比对；空 = 不校验 Origin（此时 token 必须是唯一边界）。 */
  allowedOrigins: string[]
  /** 目标 allowlist。空 = 一切默认拒（除硬禁外也没有可放行目标）。 */
  allowlist: AllowRule[]
  /** 单条 curl 的墙钟上限（注入 -m 的秒数来源，另加进程 grace）。 */
  maxTimeMs: number
  /** 响应体保留上限，对齐 web 的 MAX_PREVIEW_BYTES；超出截断。 */
  maxPreviewBytes: number
  /** /exec 请求体上限（挡巨量 POST body 撑爆内存）。 */
  maxBodyBytes: number
  /** 同时在跑的 curl 进程数上限。 */
  maxConcurrency: number
  /** 每分钟允许的请求数（滑动窗口）。 */
  ratePerMinute: number
}

const KB = 1024

/** 默认值：保守。端口 8788、60s 上限、512KB 预览（= web MAX_PREVIEW_BYTES）、1MB 请求体、并发 8、30/min。 */
export const DEFAULTS = {
  port: 8788,
  maxTimeMs: 60_000,
  maxPreviewBytes: 512 * KB,
  maxBodyBytes: 1 * 1024 * KB,
  maxConcurrency: 8,
  ratePerMinute: 30
} as const

function num(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.floor(n))
}

function list(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 从环境变量解析配置。坏值回退默认，绝不因笔误变成"全放行"。 */
export function parseConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const tokenRaw = env['CURLVIZ_TOKEN']?.trim()
  return {
    port: num(env['CURLVIZ_PORT'], DEFAULTS.port, 1),
    token: tokenRaw === undefined || tokenRaw === '' ? null : tokenRaw,
    allowedOrigins: list(env['CURLVIZ_ALLOWED_ORIGINS']).map((o) => o.toLowerCase()),
    allowlist: parseAllowlist(list(env['CURLVIZ_ALLOW'])),
    maxTimeMs: num(env['CURLVIZ_MAX_TIME_MS'], DEFAULTS.maxTimeMs, 1000),
    maxPreviewBytes: num(env['CURLVIZ_MAX_PREVIEW_BYTES'], DEFAULTS.maxPreviewBytes, 1),
    maxBodyBytes: num(env['CURLVIZ_MAX_BODY_BYTES'], DEFAULTS.maxBodyBytes, 1),
    maxConcurrency: num(env['CURLVIZ_MAX_CONCURRENCY'], DEFAULTS.maxConcurrency, 1),
    ratePerMinute: num(env['CURLVIZ_RATE_PER_MIN'], DEFAULTS.ratePerMinute, 1)
  }
}
