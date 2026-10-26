import { describe, expect, it } from 'vitest'
import { buildCollection, createDefaultSpec, redactSpec, type CurlSpec } from '@curlviz/core'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  buildShareUrl,
  QR_COMFORT_BYTES,
  QR_MAX_BYTES,
  createPayload,
  decodeShare,
  encodeShare,
  ShareError,
  shareSizeHint,
  SHARE_PREFIX
} from './share'

function demoSpec(): CurlSpec {
  const spec = createDefaultSpec('下单')
  spec.method = 'POST'
  spec.url = 'https://api.example.com/v1/orders'
  spec.headers = [{ key: 'X-Trace', value: '中文 / 空格 & 符号', enabled: true }]
  spec.body = { ...spec.body, type: 'json', json: '{"items":[{"sku":"A-1","qty":2}]}' }
  spec.auth = { type: 'basic', basic: { username: 'ops', password: 's3cr3t' }, bearer: { token: '' } }
  return spec
}

describe('base64url', () => {
  it('二进制安全且不含 + / =（这三个字符在 URL 与二维码里都是麻烦）', () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    const text = bytesToBase64Url(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect(base64UrlToBytes(text)).toEqual(bytes)
  })

  it('多字节中文绕一圈不坏', () => {
    const bytes = new TextEncoder().encode('栖云 · 内网接口')
    expect(new TextDecoder().decode(base64UrlToBytes(bytesToBase64Url(bytes)))).toBe('栖云 · 内网接口')
  })
})

describe('encodeShare / decodeShare', () => {
  it('请求：发出去的和收回来的是同一份 spec', async () => {
    const spec = demoSpec()
    const text = await encodeShare(createPayload('request', spec, false))
    expect(text.startsWith(SHARE_PREFIX)).toBe(true)
    const back = await decodeShare(text)
    expect(back.kind).toBe('request')
    expect(back.redacted).toBe(false)
    expect(back.spec).toEqual(spec)
  })

  it('集合：requests 与 environments 都带得回去', async () => {
    const collection = buildCollection([demoSpec(), demoSpec()], [
      { name: '内网', variables: [{ key: 'gw', value: '10.0.0.1', enabled: true }] }
    ])
    const back = await decodeShare(await encodeShare(createPayload('collection', collection, false)))
    expect(back.kind).toBe('collection')
    expect(back.collection?.requests).toHaveLength(2)
    expect(back.collection?.environments[0]?.variables[0]?.value).toBe('10.0.0.1')
  })

  it('gzip 确实压了，且明文标记那条路也走得通', async () => {
    const big = buildCollection(Array.from({ length: 12 }, () => demoSpec()))
    const gz = await encodeShare(createPayload('collection', big, false))
    const plain = await encodeShare(createPayload('collection', big, false), false)
    expect(gz.startsWith(`${SHARE_PREFIX}g`)).toBe(true)
    expect(plain.startsWith(`${SHARE_PREFIX}p`)).toBe(true)
    expect(gz.length).toBeLessThan(plain.length)
    expect((await decodeShare(gz)).collection?.requests).toHaveLength(12)
    expect((await decodeShare(plain)).collection?.requests).toHaveLength(12)
  })

  it('能直接从整条链接里解出来（用户复制的是地址栏那一整串）', async () => {
    const text = await encodeShare(createPayload('request', demoSpec(), false))
    const url = buildShareUrl(text, 'https://tool.example.com/curlviz/index.html')
    expect(url.startsWith('https://tool.example.com/curlviz/index.html#share=')).toBe(true)
    const back = await decodeShare(url)
    expect(back.spec?.url).toBe('https://api.example.com/v1/orders')
  })

  it('坏输入给的是能看懂的一句话，不是 DOMException', async () => {
    const cases = ['curl -v https://x', `${SHARE_PREFIX}zQQQQ`, `${SHARE_PREFIX}g@@@坏@@@`, `${SHARE_PREFIX}pY2doh`]
    for (const input of cases) {
      const err = await decodeShare(input).then(
        () => null,
        (e: unknown) => e
      )
      expect(err, `本该失败：${input}`).toBeInstanceOf(ShareError)
      expect((err as ShareError).hint.length).toBeGreaterThan(0)
    }
  })

  it('缺字段的旧 JSON 也会被补齐成能用的 spec（不会因为多版本而崩）', async () => {
    const raw = `${SHARE_PREFIX}p${bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ kind: 'request', redacted: true, spec: { url: 'https://x/y' } })))}`
    const back = await decodeShare(raw)
    expect(back.redacted).toBe(true)
    expect(back.spec?.url).toBe('https://x/y')
    expect(back.spec?.options).toBeDefined()
    expect(back.spec?.body.type).toBe('none')
  })

  it('脱敏过的分享码里不该留着密码', async () => {
    const spec = demoSpec()
    const text = await encodeShare(createPayload('request', redactSpec(spec), true))
    const back = await decodeShare(text)
    expect(back.redacted).toBe(true)
    expect(JSON.stringify(back.spec)).not.toContain('s3cr3t')
  })
})

describe('shareSizeHint', () => {
  it('小载荷不啰嗦，超容量的直说装不下', () => {
    expect(shareSizeHint('curlviz:1:pabc').message).toBeNull()
    const dense = SHARE_PREFIX + 'x'.repeat(QR_COMFORT_BYTES + 10)
    expect(shareSizeHint(dense).message).toContain('扫不动')
    const tooBig = SHARE_PREFIX + 'x'.repeat(QR_MAX_BYTES + 10)
    expect(shareSizeHint(tooBig).message).toContain('超过二维码')
  })
})
