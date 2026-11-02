import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { buildArgv } from '@curlviz/core'
import type { CurlSpec } from '@curlviz/core'
import { failure, type FailureResponse, type WireAgentResponse, type WireResponse } from './wire'

/**
 * 执行层：拿一条 spec，用 core 的 buildArgv 生成 argv，`spawn('curl', argv, { shell:false })` 真跑，
 * 把 curl 的三路输出归一成 WireAgentResponse（对齐 spec §13.3）。
 *
 * 三路怎么分（Linux / ECS 部署，curl 支持 fd://）：
 *   - 响应体 → stdout（fd1，curl 默认，不传 -o）
 *   - 响应头 → fd3（`--dump-header fd://3`，spawn 的第 4 根 stdio 管道）
 *   - 错误   → stderr（fd2，配 -sS 让 stderr 只剩真错误、无进度条噪声）
 * 绝不把请求体/响应体写进磁盘（红线）——body 只在内存里流式取，超上限即截断。
 *
 * 好测的拆法：把「怎么从 curl 输出拼出响应」这层纯逻辑（parseResponseBlocks /
 * parseStatusAndHeaders / classifyExit / assembleResponse）单独拿出来，用假数据直接钉；
 * runCurl 只是"起进程 + 喂 stdin + 收三路字节 + 调纯函数"的薄接线，真机联调留给 M4d。
 */

/* ------------------------------------------------------------------ */
/* 纯映射：curl 原始输出 → 结构化响应                                   */
/* ------------------------------------------------------------------ */

/** 拆状态行与响应头。HTTP/2 状态行没有 reason（`HTTP/2 200`），statusText 留空。 */
export function parseStatusAndHeaders(dump: string): {
  status: number
  statusText: string
  headers: [string, string][]
} {
  const lines = dump.split(/\r?\n/)
  let status = 0
  let statusText = ''
  const headers: [string, string][] = []
  let sawAnyStatusLine = false

  for (const line of lines) {
    if (line === '') continue
    // 状态行：可能有多条（如 1xx interim 后跟最终态），以最后一条为准
    const st = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b\s*(.*)$/i.exec(line)
    if (st) {
      const code = Number(st[1])
      if (Number.isFinite(code)) {
        status = code
        statusText = (st[2] ?? '').trim()
        sawAnyStatusLine = true
      }
      headers.length = 0 // 每条新状态行都重置：只保留最终响应的头
      continue
    }
    // 折叠续行（obs-fold：以空格/Tab 开头）接到上一条头的值上
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length > 0) {
      const last = headers[headers.length - 1]
      if (last) last[1] = `${last[1]} ${line.trim()}`
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (name !== '') headers.push([name.toLowerCase(), value])
  }

  return { status: sawAnyStatusLine ? status : 0, statusText, headers }
}

/** 从响应头取 content-type（大小写不敏感，取首个）。 */
export function contentTypeFrom(headers: [string, string][]): string {
  for (const [k, v] of headers) if (k.toLowerCase() === 'content-type') return v
  return ''
}

export interface AssembleInput {
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array
  totalBytes: number
  truncated: boolean
  ttfbMs: number
  totalMs: number
}

/** 归一成 WireAgentResponse：ok = 2xx（同 fetch Response.ok 语义）；body 走 base64（HTTP 文本通道）。 */
export function assembleResponse(a: AssembleInput): WireAgentResponse {
  return {
    status: a.status,
    statusText: a.statusText,
    ok: a.status >= 200 && a.status < 300,
    headers: a.headers,
    contentType: contentTypeFrom(a.headers),
    bodyBase64: base64(a.body),
    totalBytes: a.totalBytes,
    sizeExact: !a.truncated,
    truncated: a.truncated,
    ttfbMs: Math.max(0, Math.round(a.ttfbMs)),
    totalMs: Math.max(0, Math.round(a.totalMs))
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** curl 退出码 → 成功/失败分类（失败一律落成 agent 侧可表的 kind；措辞给运维能动手的下一步）。 */
export function classifyExit(code: number, stderrText: string): { ok: true } | FailureResponse {
  const err = stderrText.trim()
  if (code === 0) return { ok: true }
  if (code === 28) {
    return {
      ok: false,
      failure: {
        kind: 'timeout',
        message: `curl 超时退出（28）：${err || '超过时间上限'}`,
        hint: '调大超时上限，或确认目标是否会话挂起 / 网络抖动。'
      }
    }
  }
  const hint =
    code === 6
      ? '域名解析失败：确认 allowlist 放行的主机名在 agent 这台机器上能解析（必要时走 hosts 或 --resolve）。'
      : code === 7
        ? '连不上目标：确认端口/防火墙，或目标是否只听本机。'
        : '看 curl 报错原文定位；若是被 SSRF 之外的 curl 侧拒绝，需调整那条 spec。'
  return {
    ok: false,
    failure: {
      kind: 'agent-error',
      message: `curl 退出码 ${String(code)}：${err || '（curl 未给出 stderr 文本）'}`,
      hint
    }
  }
}

/* ------------------------------------------------------------------ */
/* 薄接线：起 curl、喂 stdin、收三路字节                                */
/* ------------------------------------------------------------------ */

export interface RunConfig {
  /** 这条 curl 的硬性墙钟上限（agent 侧封顶，秒级注入 -m）。 */
  maxTimeMs: number
  /** 响应体最多保留多少字节（超出截断，truncated=true），对齐 web 的 MAX_PREVIEW_BYTES。 */
  maxPreviewBytes: number
}

export interface RunDeps {
  /** 注入点：单测塞假 spawn，真机走默认 node spawn。 */
  spawnFn?: typeof spawn
  /** 注入时钟，测时间不用真等。 */
  now?: () => number
}

interface Sink {
  chunks: Uint8Array[]
  total: number
  dropped: boolean
  firstByteAt: number | null
}

function newSink(): Sink {
  return { chunks: [], total: 0, dropped: false, firstByteAt: null }
}

function feed(sink: Sink, buf: Uint8Array, now: () => number, max: number): void {
  if (sink.firstByteAt === null) sink.firstByteAt = now()
  sink.total += buf.byteLength
  const keptSoFar = sink.chunks.reduce((n, c) => n + c.byteLength, 0)
  const room = max - keptSoFar
  if (room <= 0) {
    sink.dropped = true
    return
  }
  if (buf.byteLength > room) {
    sink.chunks.push(buf.subarray(0, room))
    sink.dropped = true
  } else {
    sink.chunks.push(buf)
  }
}

function concat(sink: Sink): Uint8Array {
  const total = sink.chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of sink.chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

function toArr(buf: Uint8Array | string): Uint8Array {
  return typeof buf === 'string' ? new TextEncoder().encode(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * 跑一条 spec 返回归一响应。不抛错——所有失败都包成 { ok:false, failure }（wire 契约）。
 * 注意：fd:// 与 -m 追加依赖 Linux curl；本机不发真请求，真跑在 M4d 的用户 ECS 上验。
 */
export function runCurl(spec: CurlSpec, cfg: RunConfig, deps: RunDeps = {}): Promise<WireResponse> {
  const spawnFn = deps.spawnFn ?? spawn
  const now = deps.now ?? (() => Date.now())

  return new Promise<WireResponse>((resolve) => {
    const built = buildArgv(spec)
    // -m 追加在末尾，curl 对重复单值选项"最后一个生效"，确保封顶不被 spec 里的长值绕过。
    const capSeconds = Math.max(1, Math.ceil(cfg.maxTimeMs / 1000))
    const argv = [...built.argv, '-sS', '--dump-header', 'fd://3', '-m', String(capSeconds)]

    const startedAt = now()
    const body = newSink()
    const header = newSink()
    const errSink = newSink()
    let settled = false

    const finish = (r: WireResponse): void => {
      if (settled) return
      settled = true
      resolve(r)
    }

    const child: ChildProcess = spawnFn('curl', argv, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    })

    // 凭据走 --config - 的 stdin，不进 ps；没有凭据就直接关掉 stdin。
    try {
      child.stdin?.end(built.stdinConfig)
    } catch {
      /* stdin 已被 curl 关闭，忽略 */
    }

    child.stdout?.on('data', (b: Uint8Array | string) => feed(body, toArr(b), now, cfg.maxPreviewBytes))
    child.stderr?.on('data', (b: Uint8Array | string) => feed(errSink, toArr(b), now, 16 * 1024))
    const h3 = child.stdio?.[3]
    if (h3 && 'on' in h3) {
      (h3 as NodeJS.ReadableStream).on('data', (b: Uint8Array | string) => feed(header, toArr(b), now, 256 * 1024))
    }

    // 墙钟兜底：比 -m 稍宽的 grace 内没退出就 kill，防 curl 卡死。
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(
        failure('timeout', `超过 agent 上限 ${String(capSeconds)}s，已终止 curl 进程。`, '调大 agent 的 max-time 上限或缩短目标耗时。')
      )
    }, cfg.maxTimeMs + 5000)

    child.on('error', (e: Error) => {
      clearTimeout(timer)
      finish(failure('agent-error', `curl 起不来：${e.message}`, '确认 agent 这台机器装了 curl 且在 PATH。'))
    })

    const close = (code: number | null): void => {
      clearTimeout(timer)
      const endedAt = now()
      const exitCode = code ?? -1
      const cls = classifyExit(exitCode, utf8(errSink))
      if (!cls.ok) {
        finish(cls)
        return
      }
      // 退出码 0 但没状态行（如 --head 之外的怪异），如实报 agent-error 而非编 200。
      const parsed = parseStatusAndHeaders(utf8(header))
      if (parsed.status === 0) {
        finish(failure('agent-error', 'curl 正常退出但没解析到状态行。', '可能是非 HTTP 目标或 curl 版本差异，看 stderr。'))
        return
      }
      const resp = assembleResponse({
        status: parsed.status,
        statusText: parsed.statusText,
        headers: parsed.headers,
        body: concat(body),
        totalBytes: body.total,
        truncated: body.dropped,
        ttfbMs: (body.firstByteAt ?? startedAt) - startedAt,
        totalMs: endedAt - startedAt
      })
      finish({ ok: true, response: resp })
    }

    child.on('close', close)
  })
}

function utf8(sink: Sink): string {
  return new TextDecoder().decode(concat(sink))
}
