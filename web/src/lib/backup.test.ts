import { describe, expect, it } from 'vitest'
import { createDefaultSpec, type CurlSpec } from '@curlviz/core'
import { addCollection, saveRequest, EMPTY_COLLECTION_STATE, type CollectionState } from './collections'
import { addEnv, DEFAULT_ENV_NAME, emptyEnvs, setActive, upsertVar, type EnvState } from './environments'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  looksLikeBackup,
  mergeBackup,
  parseBackup,
  serializeBackup,
  type BackupData
} from './backup'

function spec(url: string, name = 'req'): CurlSpec {
  const s = createDefaultSpec(name)
  s.url = url
  return s
}

function twoCollections(): CollectionState {
  const a = addCollection(EMPTY_COLLECTION_STATE, '生产巡检')
  let state = a.state
  const b = addCollection(state, '测试')
  state = b.state
  state = saveRequest(state, a.id, spec('https://prod.example/list', '列表')).state
  state = saveRequest(state, a.id, spec('https://prod.example/health', '健康检查')).state
  state = saveRequest(state, b.id, spec('https://test.example/list', '测试列表')).state
  return state
}

/** 默认 + 测试 两个环境，激活的是测试。 */
function envsTwo(): EnvState {
  let s = upsertVar(emptyEnvs(), DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
  s = addEnv(s, '测试').state
  s = upsertVar(s, '测试', 'gw', '10.0.0.1')
  return setActive(s, '测试')
}

describe('备份导出', () => {
  it('原样带上集合、请求、环境与激活项', () => {
    const data = buildBackup(twoCollections(), envsTwo())
    expect(data.format).toBe(BACKUP_FORMAT)
    expect(data.version).toBe(BACKUP_VERSION)
    expect(data.collections.map((c) => c.name)).toEqual(['生产巡检', '测试'])
    expect(data.collections[0]?.requests.length).toBe(2)
    expect(data.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME, '测试'])
    expect(data.activeName).toBe('测试')

    const round = parseBackup(serializeBackup(data))
    if (!round.ok) throw new Error(`应当解析成功：${round.error}`)
    expect(round.data.collections[1]?.requests[0]?.spec.url).toBe('https://test.example/list')
    expect(round.data.activeName).toBe('测试')
    expect(round.skipped).toBe(0)
  })

  it('序列化是可读多行 JSON（运维会打开看一眼）', () => {
    const text = serializeBackup(buildBackup(twoCollections(), envsTwo()))
    expect(text.split('\n').length).toBeGreaterThan(3)
    expect(looksLikeBackup(text)).toBe(true)
  })

  it('外部塞进来的破 spec 在导出时就被 normalize 补齐', () => {
    const broken = { url: 'https://x/y', headers: [{ key: 'A', value: 'b' }] } as unknown as CurlSpec
    const data = buildBackup(
      { collections: [{ id: 'c1', name: 'C', requests: [{ id: 'r1', updatedAt: 1, spec: broken }] }] },
      envsTwo()
    )
    const out = data.collections[0]?.requests[0]?.spec
    expect(out?.query).toEqual([])
    expect(out?.method).toBe('GET')
    expect(typeof out?.options.timeoutMs).toBe('number')
  })
})

describe('备份识别与拒绝', () => {
  it('集合 JSON 不是备份，不能误当备份读', () => {
    const collectionJson = '{"format":"curlviz-collection","version":1,"environments":[],"requests":[]}'
    expect(looksLikeBackup(collectionJson)).toBe(false)
    const r = parseBackup(collectionJson)
    expect(r.ok).toBe(false)
  })

  it('坏 JSON / 缺 format / 来自更新版本都明确拒绝，不猜格式', () => {
    expect(parseBackup('{').ok).toBe(false)
    const noFormat = parseBackup(JSON.stringify({ version: 1, collections: [] }))
    if (noFormat.ok) throw new Error('缺 format 应当失败')
    expect(noFormat.error).toContain(BACKUP_FORMAT)
    const future = parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, collections: [] }))
    if (future.ok) throw new Error('高版本应当拒绝')
    expect(future.error).toContain('更新的版本')
  })

  it('url 为空的条目计入 skipped；整集合都坏就不塞空集合进来', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      collections: [
        { name: '半坏', requests: [{ spec: { url: 'https://ok/a' } }, { spec: 42 }] },
        { name: '全坏', requests: [{ spec: 7 }, { spec: null }] },
        { name: '本就空', requests: [] }
      ],
      environments: [],
      activeName: null
    })
    const r = parseBackup(text)
    if (!r.ok) throw new Error(`应当解析成功：${r.error}`)
    expect(r.skipped).toBe(3)
    expect(r.data.collections.map((c) => c.name)).toEqual(['半坏', '本就空'])
    expect(r.data.collections[0]?.requests.length).toBe(1)
  })
})

describe('恢复（合并进本机）', () => {
  it('同名集合与同名环境都加序号，绝不覆盖本机已有的东西', () => {
    const data = buildBackup(twoCollections(), envsTwo())
    const merged = mergeBackup(twoCollections(), emptyEnvs(), data)
    expect(merged.colState.collections.map((c) => c.name)).toEqual(['生产巡检', '测试', '生产巡检 (2)', '测试 (2)'])
    expect(merged.addedCollections).toBe(2)
    expect(merged.addedRequests).toBe(3)
    expect(merged.addedEnvironments).toEqual([`${DEFAULT_ENV_NAME} (2)（原名 ${DEFAULT_ENV_NAME}）`, '测试'])
  })

  it('请求 id 全部换新，避免与本机已有 id 撞车', () => {
    const data = buildBackup(twoCollections(), envsTwo())
    const merged = mergeBackup(EMPTY_COLLECTION_STATE, emptyEnvs(), data)
    const ids = merged.colState.collections.flatMap((c) => c.requests.map((r) => r.id))
    const oldIds = data.collections.flatMap((c) => c.requests.map((r) => r.id))
    expect(ids.length).toBe(3)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.some((id) => oldIds.includes(id))).toBe(false)
  })

  it('激活环境跟着备份走；本机已有同名时切到加了序号的新名字并说明', () => {
    const merged = mergeBackup(EMPTY_COLLECTION_STATE, envsTwo(), buildBackup(EMPTY_COLLECTION_STATE, envsTwo()))
    expect(merged.envState.activeName).toBe('测试 (2)')
    expect(merged.activeNote).toContain('加了序号')
  })

  it('本机没冲突时直接切过去，不多嘴', () => {
    const merged = mergeBackup(EMPTY_COLLECTION_STATE, emptyEnvs(), buildBackup(EMPTY_COLLECTION_STATE, envsTwo()))
    expect(merged.envState.activeName).toBe('测试')
    expect(merged.activeNote).toBeNull()
  })

  it('备份里的激活环境对不上名字时不硬切，只说明原因', () => {
    const orphan: BackupData = { ...buildBackup(EMPTY_COLLECTION_STATE, envsTwo()), activeName: '没这个环境' }
    const merged = mergeBackup(EMPTY_COLLECTION_STATE, emptyEnvs(), orphan)
    expect(merged.envState.activeName).toBe(DEFAULT_ENV_NAME)
    expect(merged.activeNote).toContain('没对上名字')
  })

  it('空备份不改动任何状态', () => {
    const merged = mergeBackup(twoCollections(), envsTwo(), {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: 0,
      app: '',
      collections: [],
      environments: [],
      activeName: null
    })
    expect(merged.colState.collections.length).toBe(2)
    expect(merged.envState.activeName).toBe('测试')
    expect(merged.activeNote).toBeNull()
  })
})
