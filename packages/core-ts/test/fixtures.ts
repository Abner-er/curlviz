/**
 * 契约用例加载与比对工具。
 *
 * 这里放"双端都要一样"的判定逻辑：
 *   - loadFixtures：读 spec/fixtures/*.json。用 fs 而不是 import，
 *     这样 Kotlin 侧只要读同一批文件即可，不存在"两份 fixture"。
 *   - matchFixture：部分匹配。spec 里省略的字段一律不校验（契约测试只关心被显式断言的语义）。
 *   - normalize：往返等价比较用的规范化（三条规则有意的，见函数注释）。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CurlSpec, WarningCode } from '../src/index'

export interface Fixture {
  id: string
  title: string
  tags: string[]
  /** generate(parse(curl)) 是否必须逐字符等于 curl。 */
  canonical: boolean
  curl: string
  /** 期望解析结果，只断言写出来的字段。 */
  spec: Record<string, unknown>
  /** 期望出现的 warning code（不校验条数与文案）。 */
  expectWarnings: WarningCode[]
}

export interface FixtureFile {
  file: string
  fixtures: Fixture[]
}

export interface FlatFixture extends Fixture {
  file: string
}

const here = fileURLToPath(new URL('.', import.meta.url))
export const FIXTURE_DIR = join(here, '..', '..', '..', 'spec', 'fixtures')

export function loadFixtures(): FixtureFile[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const data = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as { fixtures?: Fixture[] }
      if (!Array.isArray(data.fixtures)) throw new Error(`${f} 缺少 fixtures 数组`)
      const ids = new Set<string>()
      for (const item of data.fixtures) {
        if (ids.has(item.id)) throw new Error(`${f} 里 id 重复：${item.id}`)
        ids.add(item.id)
      }
      return { file: f, fixtures: data.fixtures }
    })
}

export function flatten(files: FixtureFile[]): FlatFixture[] {
  return files.map((f) => f.fixtures.map((x) => ({ ...x, file: f.file }))).flat()
}

/** fixture 的 spec 是 partial，与完整 CurlSpec 做子集比对。 */
export function matchFixture(actual: unknown, expected: unknown, path = ''): string[] {
  if (expected === undefined) return []
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: 期望数组，实际 ${typeof actual}`]
    if (actual.length !== expected.length) {
      return [`${path}: 长度 ${actual.length} ≠ 期望 ${expected.length}`]
    }
    return expected.flatMap((e, i) => matchFixture(actual[i], e, `${path}[${i}]`))
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return [`${path}: 期望对象，实际 ${JSON.stringify(actual)}`]
    }
    const a = actual as Record<string, unknown>
    const e = expected as Record<string, unknown>
    return Object.keys(e).flatMap((k) => matchFixture(a[k], e[k], `${path}.${k}`))
  }
  return actual === expected ? [] : [`${path}: ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`]
}

/**
 * 往返比较前的规范化，三条规则都是**有意的**：
 *   - 空 body 内容与 body.type='none' 等价（生成时都不产生 body 参数），统一归到 none，
 *     否则"空 raw"绕一圈变"none"会被误判成丢数据。
 *   - auth.type='none' 时 basic/bearer 里的残留不参与发送、也不会被生成，清空。
 *   - warnings 不进比较（第二次解析不该出现词法类警告，条数差是噪音）。
 */
export function normalize(spec: CurlSpec): CurlSpec {
  const out = JSON.parse(JSON.stringify(spec)) as CurlSpec
  const b = out.body
  const emptyType =
    (b.type === 'json' && b.json.trim() === '') ||
    (b.type === 'raw' && b.raw === '') ||
    (b.type === 'form' && b.form.length === 0) ||
    (b.type === 'multipart' && b.multipart.length === 0)
  if (emptyType) out.body = { type: 'none', json: '', form: [], multipart: [], raw: '' }
  else if (b.type === 'json') out.body.json = b.json.trim()

  if (out.auth.type === 'none') {
    out.auth = { type: 'none', basic: { username: '', password: '' }, bearer: { token: '' } }
  }
  return out
}
