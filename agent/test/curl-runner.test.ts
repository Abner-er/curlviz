import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createDefaultSpec } from '@curlviz/core'
import {
  assembleResponse,
  classifyExit,
  contentTypeFrom,
  parseStatusAndHeaders,
  runCurl,
  splitHeadBody
} from '../src/curl-runner'
import type { WireResponse } from '../src/wire'

describe('parseStatusAndHeaders', () => {
  it('HTTP/1.1 带 reason，头名转小写', () => {
    const r = parseStatusAndHeaders('HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: application/json\r\n\r\n')
    expect(r.status).toBe(200)
    expect(r.statusText).toBe('OK')
    expect(r.headers).toContainEqual(['server', 'nginx'])
    expect(r.headers).toContainEqual(['content-type', 'application/json'])
  })
  it('HTTP/2 没有 reason → statusText 空', () => {
    const r = parseStatusAndHeaders('HTTP/2 204\r\n\r\n')
    expect(r.status).toBe(204)
    expect(r.statusText).toBe('')
    expect(r.headers).toHaveLength(0)
  })
  it('多条状态行取最后一条，且重置前面的头', () => {
    const r = parseStatusAndHeaders(
      'HTTP/1.1 100 Continue\r\nX-Interim: 1\r\n\r\nHTTP/1.1 200 OK\r\nServer: nginx\r\n\r\n'
    )
    expect(r.status).toBe(200)
    expect(r.headers).toEqual([['server', 'nginx']])
  })
  it('折叠续行接到上一条头', () => {
    const r = parseStatusAndHeaders('HTTP/1.1 200 OK\r\nLong: first\r\n\tsecond\r\n\r\n')
    expect(r.headers).toEqual([['long', 'first second']])
  })
  it('无状态行 → status 0（交给上层如实报错，不编 200）', () => {
    expect(parseStatusAndHeaders('garbage\r\n').status).toBe(0)
    expect(parseStatusAndHeaders('').status).toBe(0)
  })
})

describe('contentTypeFrom', () => {
  it('大小写不敏感取首个', () => {
    expect(contentTypeFrom([['CONTENT-TYPE', 'text/html; charset=utf-8']])).toBe('text/html; charset=utf-8')
    expect(contentTypeFrom([['server', 'nginx']])).toBe('')
  })
})

describe('splitHeadBody', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
  it('CRLF 头块：headerEnd 落在 \\r\\n\\r\\n 之后', () => {
    const buf = enc('HTTP/1.1 200 OK\r\nX: y\r\n\r\nbody')
    const r = splitHeadBody(buf)
    expect(r.hasBoundary).toBe(true)
    expect(r.headerEnd).toBe('HTTP/1.1 200 OK\r\nX: y\r\n\r\n'.length)
  })
  it('LF-only 分隔也认', () => {
    const buf = enc('HTTP/1.1 200 OK\nX: y\n\nbody')
    const r = splitHeadBody(buf)
    expect(r.hasBoundary).toBe(true)
    expect(r.headerEnd).toBe('HTTP/1.1 200 OK\nX: y\n\n'.length)
  })
  it('无空行边界：整段当头、体空', () => {
    const buf = enc('not-an-http\r\n')
    const r = splitHeadBody(buf)
    expect(r.hasBoundary).toBe(false)
    expect(r.headerEnd).toBe(buf.length)
  })
  it('体里也含 \\r\\n\\r\\n 时只在首个边界切（二进制安全）', () => {
    const buf = enc('HTTP/1.1 200 OK\r\n\r\nA\r\n\r\nB')
    const r = splitHeadBody(buf)
    expect(r.headerEnd).toBe('HTTP/1.1 200 OK\r\n\r\n'.length)
    // 体从首个边界起，保留其后的 \r\n\r\n 原样
    expect(new TextDecoder().decode(buf.subarray(r.headerEnd))).toBe('A\r\n\r\nB')
  })
})

describe('assembleResponse', () => {
  const base = {
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json']] as [string, string][],
    ttfbMs: 10,
    totalMs: 40
  }
  it('ok = 2xx（含边界 199/200/299/300）', () => {
    const b = new TextEncoder().encode('x')
    expect(assembleResponse({ ...base, status: 199, body: b, totalBytes: 1, truncated: false }).ok).toBe(false)
    expect(assembleResponse({ ...base, status: 200, body: b, totalBytes: 1, truncated: false }).ok).toBe(true)
    expect(assembleResponse({ ...base, status: 299, body: b, totalBytes: 1, truncated: false }).ok).toBe(true)
    expect(assembleResponse({ ...base, status: 300, body: b, totalBytes: 1, truncated: false }).ok).toBe(false)
  })
  it('body 走 base64；sizeExact = !truncated', () => {
    const r = assembleResponse({ ...base, body: new Uint8Array([0x61, 0x62, 0x63]), totalBytes: 3, truncated: false })
    expect(r.bodyBase64).toBe('YWJj')
    expect(r.sizeExact).toBe(true)
    expect(r.truncated).toBe(false)
    const t = assembleResponse({ ...base, body: new Uint8Array([0x61]), totalBytes: 999, truncated: true })
    expect(t.sizeExact).toBe(false)
    expect(t.totalBytes).toBe(999)
  })
})

describe('classifyExit', () => {
  it('0 → ok', () => expect(classifyExit(0, '')).toEqual({ ok: true }))
  it('28 → timeout', () => {
    const r = classifyExit(28, 'Operation timed out')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure.kind).toBe('timeout')
      expect(r.failure.message).toContain('28')
    }
  })
  it('6 → 解析失败提示；7 → 连不上提示；其它 → agent-error 带原文', () => {
    const r6 = classifyExit(6, 'Could not resolve host: x')
    if (!r6.ok) expect(r6.failure.hint).toContain('解析')
    const r7 = classifyExit(7, 'Failed to connect')
    if (!r7.ok) expect(r7.failure.hint).toContain('连不上')
    const r52 = classifyExit(52, 'Empty reply from server')
    if (!r52.ok) {
      expect(r52.failure.kind).toBe('agent-error')
      expect(r52.failure.message).toContain('Empty reply from server')
    }
  })
})

/* ------------------------------------------------------------------ */
/* runCurl：假 spawn 驱动三路流，验薄接线与截断/超时分类                */
/* ------------------------------------------------------------------ */

function fakeChild(): {
  child: EventEmitter & Record<string, unknown>
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
} {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.stdio = [stdin, stdout, stderr]
  child.kill = (): void => {}
  return { child, stdin, stdout, stderr }
}

const spec = (): ReturnType<typeof createDefaultSpec> => {
  const s = createDefaultSpec('t')
  s.url = 'https://internal.api/v1'
  s.options.followRedirects = false
  return s
}

// curl -i 把头块前置到 stdout、与体同一条流：这里把 headerBlock + body 依次写进 stdout 复现。
async function withRun(
  bodyChunks: (string | Uint8Array)[],
  headerBlock: string,
  code: number | null,
  opts: { maxPreviewBytes?: number; errText?: string; errorEv?: Error } = {}
): Promise<WireResponse> {
  const f = fakeChild()
  let clock = 1000
  const spawnFn = (() => f.child) as unknown as typeof import('node:child_process').spawn
  const p = runCurl(spec(), { maxTimeMs: 30_000, maxPreviewBytes: opts.maxPreviewBytes ?? 1024 }, {
    spawnFn,
    now: () => clock++
  })
  // PassThrough 的 data 是异步派发：写完后必须等流把 data 全吐出来，再 emit close，
  // 否则 runCurl 可能还没收到 stdout/stderr 就走了收尾分支。
  f.stdout.write(Buffer.from(headerBlock))
  for (const c of bodyChunks) f.stdout.write(typeof c === 'string' ? Buffer.from(c) : c)
  if (opts.errText) f.stderr.write(Buffer.from(opts.errText))
  f.stderr.end()
  f.stdout.end()
  await Promise.all([onceEnd(f.stdout), onceEnd(f.stderr)])
  if (opts.errorEv) f.child.emit('error', opts.errorEv)
  else f.child.emit('close', code)
  return p
}

function onceEnd(s: PassThrough): Promise<void> {
  return new Promise((res) => {
    if (s.readableEnded) return res()
    s.once('end', () => res())
  })
}

describe('runCurl（假 spawn）', () => {
  it('正常：拼出 WireAgentResponse，body base64、时间自增时钟', async () => {
    const r = await withRun(['{"a":1}'], 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n', 0)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.response.status).toBe(200)
      expect(r.response.ok).toBe(true)
      expect(r.response.contentType).toBe('application/json')
      expect(Buffer.from(r.response.bodyBase64, 'base64').toString('utf8')).toBe('{"a":1}')
      expect(r.response.totalBytes).toBe(7)
      expect(r.response.sizeExact).toBe(true)
      expect(r.response.totalMs).toBeGreaterThan(0)
    }
  })

  it('超上限截断：totalBytes 记全量、truncated=true、base64 只含保留部分', async () => {
    const r = await withRun(['abcdefghij'], 'HTTP/1.1 200 OK\r\n\r\n', 0, { maxPreviewBytes: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.response.totalBytes).toBe(10)
      expect(r.response.truncated).toBe(true)
      expect(r.response.sizeExact).toBe(false)
      expect(Buffer.from(r.response.bodyBase64, 'base64').toString('utf8')).toBe('abcd')
    }
  })

  it('curl 退出 28 → timeout', async () => {
    const r = await withRun([], '', 28, { errText: 'Operation timed out after 30000 milliseconds' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.kind).toBe('timeout')
  })

  it('退出码 0 却无状态行 → agent-error（不编 200）', async () => {
    const r = await withRun(['body'], 'not-an-http-dump\r\n', 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.kind).toBe('agent-error')
  })

  it('spawn error 事件 → agent-error（curl 起不来）', async () => {
    const r = await withRun([], '', 0, { errorEv: new Error('ENOENT curl') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.message).toContain('curl 起不来')
  })
})

describe('runCurl 注入面（shell:false + 程序名钉死 curl）', () => {
  it('spawn 收到 ("curl", argv[], {shell:false})，值里带 shell 元字符也只喂 curl、不进任何 shell', async () => {
    const f = fakeChild()
    let cmd = ''
    let args: string[] = []
    let opts: Record<string, unknown> = {}
    const spawnFn = ((c: string, a: string[], o: Record<string, unknown>) => {
      cmd = c
      args = a
      opts = o
      return f.child
    }) as unknown as typeof import('node:child_process').spawn

    const s = createDefaultSpec('t')
    s.url = 'https://internal.api/v1'
    s.options.followRedirects = false
    // 合法 rawArgs：每个元素是一个 bash token（§10.1 #1）。即便值里含 shell 元字符，
    // spawn('curl', argv, {shell:false}) 也只把它们当 curl 的参数（curl 数据，非 shell 命令），
    // 不存在把 ;/|/& 交给 shell 执行的路径——这就是注入面被"构造"消除的根据。
    s.rawArgs = ['--output', '/tmp/out.bin']

    const p = runCurl(s, { maxTimeMs: 30_000, maxPreviewBytes: 1024 }, { spawnFn, now: () => 1 })
    f.stdout.write(Buffer.from('HTTP/1.1 200 OK\r\n\r\n'))
    f.stdout.end()
    f.stderr.end()
    await Promise.all([onceEnd(f.stdout), onceEnd(f.stderr)])
    f.child.emit('close', 0)
    await p

    // 核心安全性质：程序名钉死是 curl、参数是数组、没有 shell 解释器
    expect(cmd).toBe('curl')
    expect(Array.isArray(args)).toBe(true)
    expect(opts.shell).toBe(false)
    // 绝不会被重写成 shell 调用（没有 sh/bash/-c 这类"再起一个解释器"的形态）
    expect(args).not.toContain('sh')
    expect(args).not.toContain('bash')
    expect(args).not.toContain('-c')
    // 合法 rawArgs 原样进 argv（逐 token 保真）
    expect(args).toContain('--output')
    expect(args).toContain('/tmp/out.bin')
    // runner 追加的头/体分离（-i）与封顶（-m）确实在 argv 里
    expect(args).toContain('-i')
    expect(args).toContain('-m')
    // 已证伪的 fd:// 方案不得再回来
    expect(args).not.toContain('--dump-header')
    expect(args).not.toContain('fd://3')
  })
})
