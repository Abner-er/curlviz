/**
 * 契约测试：TS 与 Kotlin 两端在同一批 spec/fixtures/*.json 上必须得到同一结果。
 *
 * 每条用例跑三件事：
 *   1. parse(curl) ⊇ spec        —— 只断言 fixture 显式写出来的字段（partial match）
 *   2. canonical 用例：generate(parse(curl)) 逐字符 === curl
 *      注意起点是 **parse 出来的完整 spec**，不是 fixture 的 partial spec：
 *      否则 parse/generate 两端的不对称会被 fixture 里"手抄的期望值"掩盖掉。
 *   3. 往返幂等：generate → parse 规范化后必须等价
 *      —— 这条不许失败，它保证"复制到终端能跑，粘回来还是同一个请求"。
 */

import { describe, expect, it } from 'vitest'
import { generateCurl, parseCurl } from '../src/index'
import { flatten, loadFixtures, matchFixture, normalize, type FlatFixture } from './fixtures'

const files = loadFixtures()
const all = flatten(files)


describe('fixture 自身健康度', () => {
  it(`共 ${all.length} 条用例、${files.length} 个文件`, () => {
    // 这个数字是刻意写死的绊线：增删 fixture 时必须同步改这里，
    // 这样"文件被误删/漏读"和"手滑改坏目录"都会被立刻拦下。
    expect(all.length, '用例总数').toBe(85)
    expect(files.length).toBe(7)
  })

  it('能读到 7 个 fixture 文件', () => {
    expect(files.map((f) => f.file).sort()).toEqual([
      'body.json',
      'book-curl.json',
      'headers-and-auth.json',
      'options-and-rawargs.json',
      'resolve.json',
      'tokenizer-edge.json',
      'url-and-query.json'
    ])
  })

  it('id 全局唯一', () => {
    const ids = all.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每条都有标题、标签与期望告警字段', () => {
    for (const f of all) {
      expect(f.title, `${f.id} 缺 title`).toBeTruthy()
      expect(Array.isArray(f.tags) && f.tags.length > 0, `${f.id} 缺 tags`).toBe(true)
      expect(Array.isArray(f.expectWarnings), `${f.id} 缺 expectWarnings`).toBe(true)
      expect(typeof f.canonical, `${f.id} 缺 canonical`).toBe('boolean')
    }
  })
})

describe('parse：命令 → CurlSpec', () => {
  for (const f of all) {
    it(`${f.id} — ${f.title}`, () => {
      const result = parseCurl(f.curl)
      const mismatches = matchFixture(result.spec, f.spec)
      expect(mismatches, `实际 spec=${JSON.stringify(result.spec, null, 2)}`).toEqual([])
      const codes = result.warnings.map((w) => w.code)
      for (const expected of f.expectWarnings) {
        expect(codes, `缺 warning ${expected}，实际 ${JSON.stringify(codes)}`).toContain(expected)
      }
    })
  }
})

describe('parse：canonical 用例的生成结果必须逐字符等于 curl', () => {
  const canonical = all.filter((f: FlatFixture) => f.canonical)
  it('canonical 用例数量足够（否则等于没测生成方向）', () => {
    expect(canonical.length).toBeGreaterThanOrEqual(20)
  })

  for (const f of canonical) {
    it(f.id, () => {
      // 起点用 parse 出来的完整 spec：parse 与 generate 的不对称必须在这里暴露
      expect(generateCurl(parseCurl(f.curl).spec)).toBe(f.curl)
    })
  }
})

describe('往返幂等：generate → parse 不丢语义', () => {
  for (const f of all) {
    it(f.id, () => {
      const first = parseCurl(f.curl)
      const command = generateCurl(first.spec)
      const second = parseCurl(command)
      const a = normalize(first.spec)
      const b = normalize(second.spec)
      expect(b, `一次生成=${command}`).toEqual(a)
      // 第二次解析不该再冒出新告警（词法类问题只可能来自第一次的输入形态）
      const newCodes = second.warnings.map((w) => w.code).filter((c) => c !== 'unknown-flag')
      for (const code of newCodes) {
        expect(
          first.warnings.map((w) => w.code),
          `往返后新出现 ${code}，说明生成的命令有问题：${command}`
        ).toContain(code)
      }
    })
  }
})

describe('parse：失败也不丢已解析部分', () => {
  it('完全空输入直接抛错', () => {
    expect(() => parseCurl('')).toThrow(/空/)
    expect(() => parseCurl('   ')).toThrow(/空/)
  })

  it('没有 curl 关键字时抛错并给出位置', () => {
    expect(() => parseCurl('echo hello')).toThrow(/没找到 curl/)
  })

  it('缺 URL 时抛错，但已解析的方法/头仍可用（表单不能整片空白）', () => {
    const result = parseCurl("curl -X POST -H 'A: b'")
    expect(result.spec.method).toBe('POST')
    expect(result.spec.headers).toEqual([{ key: 'A', value: 'b', enabled: true }])
    expect(result.warnings.some((w) => w.code === 'malformed')).toBe(true)
  })

  it('多个 URL 位置参数：第一个进 url，其余原样保留并告警', () => {
    const result = parseCurl("curl 'https://a/x' 'https://b/y'")
    expect(result.spec.url).toBe('https://a/x')
    expect(result.spec.rawArgs.join(' ')).toContain('https://b/y')
    expect(result.warnings.map((w) => w.code)).toContain('extra-url')
  })

  it('多条命令只解析第一条并告警', () => {
    const result = parseCurl("curl 'https://a/x' -L; curl 'https://b/y'")
    expect(result.spec.url).toBe('https://a/x')
    expect(result.warnings.map((w) => w.code)).toContain('multiple-commands')
  })

  it('shell 变量原样保留并警告"不保证等价"', () => {
    const result = parseCurl("curl -H \"X-Token: $TOKEN\" 'https://a/x'")
    expect(result.spec.headers[0]).toEqual({ key: 'X-Token', value: '$TOKEN', enabled: true })
    expect(result.warnings.map((w) => w.code)).toContain('shell-substitution')
  })
})
