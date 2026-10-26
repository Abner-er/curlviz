import { describe, expect, it } from 'vitest'
import { REDACTED_MASK, createDefaultSpec, redactSpec } from '@curlviz/core'
import type { HistoryEntry } from '../types'
import { entryForEditor, redactionNoteOnOpen } from './history'

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
