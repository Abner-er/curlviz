import { describe, expect, it } from 'vitest'
import { REDACTED_MASK, createDefaultSpec, hasSensitive, redactSpec } from '@curlviz/core'
import type { HistoryEntry, SentResponse, SendOutcome } from '../types'
import { appendHistory, entryForEditor, makeHistoryEntry, redactionNoteOnOpen, resultFromOutcome } from './history'

function makeSpec(bearer = '') {
  const s = createDefaultSpec('取回测试')
  s.url = 'https://api.example.com/x'
  s.auth = { type: bearer ? 'bearer' : 'none', basic: { username: '', password: '' }, bearer: { token: bearer } }
  return s
}

function entry(spec: HistoryEntry['spec'], redacted: boolean): HistoryEntry {
  return { id: 'h1', at: 1730000000000, spec, redacted }
}

describe('redactionNoteOnOpen', () => {
  it('干净请求取回时不多嘴', () => {
    expect(redactionNoteOnOpen(makeSpec())).toBeNull()
  })

  it('条目被标成脱敏 → 提示要自己填凭据', () => {
    const note = redactionNoteOnOpen(makeSpec(), true)
    expect(note).not.toBeNull()
    expect(note!).toContain('要自己填')
  })

  it('没标记但值里确实带着遮盖串也照样提示（标记可能来自旧版本或被手改过）', () => {
    const s = makeSpec()
    s.headers = [{ key: 'Authorization', value: REDACTED_MASK, enabled: true }]
    expect(redactionNoteOnOpen(s)).not.toBeNull()
  })

  it('提示里带的是真实遮盖串，用户看一眼就知道界面上那个点串是什么意思', () => {
    expect(redactionNoteOnOpen(makeSpec(), true)).toContain(REDACTED_MASK)
  })
})

describe('entryForEditor', () => {
  it('交出去的 spec 是副本：在编辑器里改它不会把历史条目一起改了', () => {
    const original = makeSpec('token-abc')
    const e = entry(original, false)
    const picked = entryForEditor(e)
    picked.spec.url = 'https://changed.example.com'
    picked.spec.auth.bearer.token = '填回来的真值'
    expect(e.spec.url).toBe('https://api.example.com/x')
    expect(e.spec.auth.bearer.token).toBe('token-abc')
  })

  it('脱敏过的历史条目取回时会带提示', () => {
    const masked = redactSpec(makeSpec('token-abc'))
    const picked = entryForEditor(entry(masked, true))
    expect(picked.spec.auth.bearer.token).toBe(REDACTED_MASK)
    expect(picked.note).not.toBeNull()
  })

  it('正常历史条目取回不带提示（不制造无用告警）', () => {
    const picked = entryForEditor(entry(makeSpec('token-abc'), false))
    expect(picked.note).toBeNull()
    expect(picked.spec.auth.bearer.token).toBe('token-abc')
  })
})

/* ------------------------------------------------------------------ */

function okResponse(status = 200, ms = 12): SentResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    ok: status < 400,
    headers: [],
    contentType: 'application/json',
    bytes: new Uint8Array(),
    totalBytes: 0,
    sizeExact: true,
    truncated: false,
    text: '{}',
    kind: 'json',
    ttfbMs: ms - 1,
    totalMs: ms
  }
}

describe('resultFromOutcome', () => {
  it('成功压成状态码 + 耗时（历史列表那一行只放得下这些）', () => {
    const outcome: SendOutcome = { ok: true, response: okResponse(204, 37) }
    expect(resultFromOutcome(outcome)).toEqual({ status: 204, ok: true, ms: 37 })
  })

  it('失败只留一句话原因，kind / hint 留在发送结果里不进历史', () => {
    const outcome: SendOutcome = {
      ok: false,
      failure: { kind: 'blocked-or-network', message: '请求被浏览器拦住了', hint: '多半是 CORS', raw: 'TypeError' }
    }
    expect(resultFromOutcome(outcome)).toEqual({ error: '请求被浏览器拦住了' })
  })
})

describe('makeHistoryEntry', () => {
  const base = { id: 'h-1', sentAt: 1730000000000 }

  it('开脱敏 + 带凭据 → 存遮盖版，且 redacted 标记为真（两者必须同源）', () => {
    const e = makeHistoryEntry({ ...base, spec: makeSpec('token-abc'), redactHistory: true, result: undefined })
    expect(e.redacted).toBe(true)
    expect(e.spec.auth.bearer.token).toBe(REDACTED_MASK)
    expect(hasSensitive(e.spec)).toBe(false)
  })

  it('关脱敏 → 存原文，redacted 为假（用户明确选择留真凭据在本地）', () => {
    const e = makeHistoryEntry({ ...base, spec: makeSpec('token-abc'), redactHistory: false, result: undefined })
    expect(e.redacted).toBe(false)
    expect(e.spec.auth.bearer.token).toBe('token-abc')
  })

  it('没有凭据时 redacted 恒为假，别给用户一个假的"已脱敏"标签', () => {
    const e = makeHistoryEntry({ ...base, spec: makeSpec(), redactHistory: true, result: undefined })
    expect(e.redacted).toBe(false)
    expect(e.spec.auth.bearer.token).toBe('')
  })

  it('只把凭据写在 query 里的命令也算敏感（hasSensitive 判据与 redactSpec 同源的那次回归）', () => {
    const s = makeSpec()
    s.query = [{ key: 'access_token', value: 'plain-secret', enabled: true }]
    const e = makeHistoryEntry({ ...base, spec: s, redactHistory: true, result: undefined })
    expect(e.redacted).toBe(true)
    expect(e.spec.query[0]!.value).toBe(REDACTED_MASK)
  })

  it('不脱敏时存的也是副本：编辑器之后怎么改都动不到历史', () => {
    const s = makeSpec()
    const e = makeHistoryEntry({ ...base, spec: s, redactHistory: false, result: undefined })
    e.spec.url = 'https://后来被改掉的.example.com'
    expect(s.url).toBe('https://api.example.com/x')
  })

  it('redacted 标记与存进去的内容永远对得上（独立复算一次，防两份逻辑分家）', () => {
    for (const bearer of ['', 'token-abc']) {
      for (const redactHistory of [true, false]) {
        const spec = makeSpec(bearer)
        const e = makeHistoryEntry({ ...base, spec, redactHistory, result: undefined })
        expect(e.redacted).toBe(redactHistory && hasSensitive(spec))
        expect(e.redacted).toBe(!hasSensitive(e.spec) && hasSensitive(spec))
      }
    }
  })
})

describe('appendHistory', () => {
  const at = (n: number): HistoryEntry => ({ id: `h${n}`, at: n, spec: createDefaultSpec(), redacted: false })

  it('新的插最前面（列表按时间倒序读）', () => {
    const next = appendHistory([at(1), at(2)], at(3), 50)
    expect(next.map((e) => e.id)).toEqual(['h3', 'h1', 'h2'])
  })

  it('超过上限从尾巴上掉，最新一条一定留得住', () => {
    const old = [at(5), at(4), at(3)]
    const next = appendHistory(old, at(6), 3)
    expect(next.map((e) => e.id)).toEqual(['h6', 'h5', 'h4'])
  })

  it('默认上限就是存储层那个 HISTORY_LIMIT，不留两份数字', () => {
    const many = Array.from({ length: 60 }, (_, i) => at(i))
    expect(appendHistory(many, at(999)).length).toBe(50)
  })
})
