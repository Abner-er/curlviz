import { timingSafeEqual } from 'node:crypto'
import { buildArgv } from '@curlviz/core'
import type { CurlSpec } from '@curlviz/core'
import type { AgentConfig } from './config'
import { evaluateSsrf } from './ssrf'
import { failure, parseExecRequest, type FailureResponse } from './wire'

/**
 * 无状态的准入判定：Origin → token → 请求契约 → argv 构造 → SSRF。
 * 全放这一层是因为它能脱离 node http 用普通对象直接测；有状态的限流（并发/速率）留给 server。
 *
 * 顺序是"最便宜的先拒"：头比对 → JSON 校验 → 纯函数建 argv → 位运算白名单，
 * 任一步失败就返回一条 agent-rejected/agent-error，server 拿去配 HTTP 码再落审计。
 */

export interface AccessRequestHeaders {
  /** 请求头 Origin（小写值即可，比对前统一 lower）。 */
  origin?: string
  /** 请求头 X-Curlviz-Token。 */
  token?: string
}

export type AccessResult =
  | { allow: true; spec: CurlSpec; argv: string[] }
  | { allow: false; response: FailureResponse; status: number }

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // 长度不等直接否（token 长度是配置常量，泄露长度无碍）；等长走常量时间比较防计时侧信道。
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * 校验并放行一条 /exec 请求。json 是已读完并 JSON.parse 过的请求体（server 负责限请求体大小与解析）。
 * @param json 解析出的请求体（未知形状，交给 parseExecRequest 深检）
 */
export function checkAccess(json: unknown, headers: AccessRequestHeaders, cfg: AgentConfig): AccessResult {
  // 1) Origin：配了白名单就必须命中（借自定义头触发的预检 + 白名单，挡 CSRF 与 DNS-rebinding）。
  if (cfg.allowedOrigins.length > 0) {
    const origin = headers.origin?.toLowerCase() ?? ''
    if (origin === '' || !cfg.allowedOrigins.includes(origin)) {
      return {
        allow: false,
        status: 403,
        response: failure('agent-rejected', 'Origin 不在白名单。', `把页面来源加进 CURLVIZ_ALLOWED_ORIGINS（当前只放行：${cfg.allowedOrigins.join(', ')}）。`)
      }
    }
  }

  // 2) token：唯一安全边界。配了就必须逐字匹配；没配（反代已鉴权，决策③）则跳过。
  if (cfg.token !== null) {
    const got = headers.token ?? ''
    if (!tokenEquals(cfg.token, got)) {
      return {
        allow: false,
        status: 401,
        response: failure('agent-rejected', '缺少或不匹配 X-Curlviz-Token。', '在执行机管理里重填 token（token 只存会话内存，刷新后需重填）。')
      }
    }
  }

  // 3) 请求契约：只认 v:1、spec 是对象、url 非空。
  const parsed = parseExecRequest(json)
  if (!parsed.ok) {
    return { allow: false, status: 400, response: parsed.response }
  }
  const spec = parsed.request.spec

  // 4) 构造 argv（纯函数，注入安全由逐 token 构造保证）。抛错说明 spec 有意外形状。
  let argv: string[]
  try {
    argv = buildArgv(spec).argv
  } catch (e) {
    return {
      allow: false,
      status: 500,
      response: failure('agent-error', `构造 argv 失败：${(e as Error).message}`, '这条 spec 可能含 agent 无法表达的片段，试着简化后重发。')
    }
  }

  // 5) SSRF：扫最终 argv + url，先硬禁元数据再默认拒白名单。
  const decision = evaluateSsrf({ argv, url: spec.url, rules: cfg.allowlist })
  if (!decision.ok) {
    return {
      allow: false,
      status: 403,
      response: failure('agent-rejected', decision.reason, decision.hint)
    }
  }

  return { allow: true, spec, argv }
}
