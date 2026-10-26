import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCollection, createDefaultSpec, redactSpec, type CurlSpec } from '@curlviz/core'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  buildShareUrl,
  clearShareHash,
  QR_COMFORT_BYTES,
  QR_MAX_BYTES,
  createPayload,
  decodeShare,
  encodeShare,
  ShareError,
  shareErrorText,
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

describe('跨端参考样本（spec/README §9.4）', () => {
  /**
   * 这串是本实现生成的明文样本，文档里贴着同一串给安卓（M3）对拍用。
   * 只断言**解码方向**：重新编码的字节顺序取决于各端对象的键序，不跨端可比，
   * 所以任何端都不许拿"生成结果必须等于这串"当验收条件。
   */
  const VECTOR =
    'curlviz:1:peyJraW5kIjoicmVxdWVzdCIsInJlZGFjdGVkIjp0cnVlLCJhdCI6MTczMDAwMDAwMDAwMCwic3BlYyI6eyJ2ZXJzaW9uIjoxLCJuYW1lIjoi56S65L6L77ya5Y-W5Zue5LiA5Liq55So5oi3IiwibWV0aG9kIjoiR0VUIiwidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdXNlcnMvNDIiLCJxdWVyeSI6W3sia2V5IjoidmVyYm9zZSIsInZhbHVlIjoiMSIsImVuYWJsZWQiOnRydWV9XSwiaGVhZGVycyI6W3sia2V5IjoiQWNjZXB0IiwidmFsdWUiOiJhcHBsaWNhdGlvbi9qc29uIiwiZW5hYmxlZCI6dHJ1ZX1dLCJib2R5Ijp7InR5cGUiOiJub25lIiwianNvbiI6IiIsImZvcm0iOltdLCJtdWx0aXBhcnQiOltdLCJyYXciOiIifSwiYXV0aCI6eyJ0eXBlIjoiYmVhcmVyIiwiYmFzaWMiOnsidXNlcm5hbWUiOiIiLCJwYXNzd29yZCI6IiJ9LCJiZWFyZXIiOnsidG9rZW4iOiLigKLigKLigKLigKLigKLigKLigKLigKIifX0sIm9wdGlvbnMiOnsiZm9sbG93UmVkaXJlY3RzIjp0cnVlLCJpbnNlY3VyZSI6ZmFsc2UsImNvbXByZXNzZWQiOnRydWUsInRpbWVvdXRNcyI6MTAwMDAsImNvbm5lY3RUaW1lb3V0TXMiOjAsInVzZXJBZ2VudCI6IiIsInByb3h5IjoiIn0sInJhd0FyZ3MiOltdfX0'

  it('解码这串样本得到的是文档里写的那个请求', async () => {
    const back = await decodeShare(VECTOR)
    expect(back.kind).toBe('request')
    expect(back.redacted).toBe(true)
    expect(back.at).toBe(1730000000000)
    expect(back.spec?.url).toBe('https://api.example.com/users/42')
    expect(back.spec?.name).toBe('示例：取回一个用户')
    expect(back.spec?.query[0]).toEqual({ key: 'verbose', value: '1', enabled: true })
    expect(back.spec?.options.timeoutMs).toBe(10000)
  })

  it('样本标了 redacted，令牌就必须已经是遮盖态（原令牌不许出现在码里）', async () => {
    const back = await decodeShare(VECTOR)
    expect(back.spec?.auth.type).toBe('bearer')
    expect(back.spec?.auth.bearer.token).toBe('••••••••')
    expect(VECTOR).not.toContain('super-secret-token')
  })

  it('明文标记与 gzip 标记解出的是同一份内容（标记只说压缩，不改语义）', async () => {
    const gz = await encodeShare(await decodeShare(VECTOR), true)
    expect(gz.startsWith(`${SHARE_PREFIX}g`)).toBe(true)
    expect((await decodeShare(gz)).spec).toEqual((await decodeShare(VECTOR)).spec)
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

describe('shareErrorText', () => {
  it('ShareError 把 hint 一起说出来：漏字符才是最常见的坏法', () => {
    const e = new ShareError('这不是 CurlViz 的分享码', '确认整串都复制全了，末尾少一个字符就解不开')
    expect(shareErrorText(e)).toBe('这不是 CurlViz 的分享码（确认整串都复制全了，末尾少一个字符就解不开）')
  })

  it('其它异常（浏览器没有 CompressionStream 之类）原样带出，不冒充成格式问题', () => {
    expect(shareErrorText(new Error('CompressionStream is not defined'))).toBe(
      '分享链接解不开：Error: CompressionStream is not defined'
    )
    expect(shareErrorText('字符串抛的错')).toContain('分享链接解不开：')
  })
})

describe('clearShareHash', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('抹掉 hash：新地址只剩 pathname + search（不抹就刷新一次重复导入一次）', () => {
    const calls: string[] = []
    vi.stubGlobal('location', { pathname: '/app', search: '?v=2', hash: '#share=curlviz:1:abc' })
    vi.stubGlobal('history', {
      replaceState: (_d: unknown, _t: string, url: string) => {
        calls.push(url)
      }
    })
    clearShareHash()
    expect(calls).toEqual(['/app?v=2'])
  })

  it('没有 location / 没有 replaceState 的环境静默跳过，不抛（测试与非浏览器宿主都会走到）', () => {
    expect(() => clearShareHash()).not.toThrow()
  })
})
