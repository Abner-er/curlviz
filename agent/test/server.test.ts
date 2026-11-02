import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { CURLSPEC_VERSION, createDefaultSpec } from '@curlviz/core'
import { createAgentServer } from '../src/server'
import type { AgentConfig } from '../src/config'
import { parseAllowlist } from '../src/ssrf'

const TOKEN = 'testtok'
const ORIGIN = 'http://127.0.0.1' // fetch 会带真实端口，比对时按 startsWith 处理不了；下面用固定 cfg origin

function baseCfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    token: TOKEN,
    allowedOrigins: [],
    allowlist: parseAllowlist(['internal.api']),
    maxTimeMs: 5000,
    maxPreviewBytes: 65536,
    maxBodyBytes: 4096,
    maxConcurrency: 8,
    ratePerMinute: 1000,
    ...over
  }
}

function specJson(url: string): string {
  const spec = createDefaultSpec('t')
  spec.url = url
  spec.options.followRedirects = false
  return JSON.stringify({ v: CURLSPEC_VERSION, spec })
}

let server: Server
let origin: string

beforeAll(async () => {
  server = createAgentServer(baseCfg())
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${String(port)}`
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
})

async function postExec(body: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${origin}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-curlviz-token': TOKEN, origin, ...headers },
    body
  })
  return { status: res.status, json: await res.json() }
}

describe('/exec HTTP 外壳（只走拒绝分支，不触发 curl，不外发请求）', () => {
  it('GET /healthz → 200', async () => {
    const res = await fetch(`${origin}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, service: 'curlviz-agent' })
  })

  it('GET 未知路径 → 404', async () => {
    const res = await fetch(`${origin}/nope`)
    expect(res.status).toBe(404)
  })

  it('Content-Type 非 json → 415', async () => {
    const res = await fetch(`${origin}/exec`, { method: 'POST', headers: { 'x-curlviz-token': TOKEN, origin }, body: 'x' })
    expect(res.status).toBe(415)
  })

  it('缺 token → 401 agent-rejected', async () => {
    const r = await postExec(specJson('https://internal.api'), { 'x-curlviz-token': '' })
    expect(r.status).toBe(401)
    expect(r.json).toMatchObject({ ok: false, failure: { kind: 'agent-rejected' } })
  })

  it('非法 JSON → 400', async () => {
    const r = await postExec('{not json')
    expect(r.status).toBe(400)
    expect(r.json.failure.kind).toBe('agent-rejected')
  })

  it('版本不符 → 400', async () => {
    const r = await postExec(JSON.stringify({ v: 99, spec: { url: 'https://internal.api' } }))
    expect(r.status).toBe(400)
  })

  it('未放行主机 → 403（SSRF not-allowed），且不落 runCurl', async () => {
    const r = await postExec(specJson('https://evil.com'))
    expect(r.status).toBe(403)
    expect(r.json).toMatchObject({ ok: false, failure: { kind: 'agent-rejected' } })
    expect(r.json.failure.message).toContain('allowlist')
  })

  it('元数据地址 → 403（硬禁）', async () => {
    const r = await postExec(specJson('http://169.254.169.254/latest/meta-data'))
    expect(r.status).toBe(403)
    expect(r.json.failure.message).toContain('硬禁')
  })

  it('请求体超上限 → 413', async () => {
    const big = specJson('https://internal.api') + ' '.repeat(5000)
    const r = await postExec(big)
    expect(r.status).toBe(413)
  })

  it('Origin 白名单：设了列表，不符 → 403', async () => {
    const s = createAgentServer(baseCfg({ allowedOrigins: ['http://allowed.example'] }))
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', res))
    const { port } = s.address() as AddressInfo
    const r = await fetch(`http://127.0.0.1:${String(port)}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-curlviz-token': TOKEN, origin: 'http://evil.example' },
      body: specJson('https://internal.api')
    })
    expect(r.status).toBe(403)
    await new Promise<void>((res) => s.close(() => res()))
  })
})

describe('限流接线（速率在闸门之前，拒绝请求也计数）', () => {
  it('ratePerMinute=1：第二发 → 429', async () => {
    const s = createAgentServer(baseCfg({ ratePerMinute: 1 }))
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', res))
    const { port } = s.address() as AddressInfo
    const url = `http://127.0.0.1:${String(port)}/exec`
    const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-curlviz-token': TOKEN, origin }, body: specJson('https://evil.com') })
    const second = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-curlviz-token': TOKEN, origin }, body: specJson('https://evil.com') })
    expect(first.status).toBe(403) // 过了速率，被 SSRF 拒
    expect(second.status).toBe(429) // 被速率挡
    await new Promise<void>((res) => s.close(() => res()))
  })
})
