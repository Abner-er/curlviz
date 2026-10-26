import { describe, expect, it } from 'vitest'
import type { Environment } from '@curlviz/core'
import {
  addEnv,
  commitRows,
  DEFAULT_ENV_NAME,
  emptyEnvs,
  mergeEnvironments,
  migrateLegacyVars,
  removeEnv,
  removeVar,
  renameEnv,
  sanitizeEnvState,
  rowsForEditor,
  setActive,
  uniqueEnvName,
  upsertVar,
  varOrigin,
  varsFor,
  type EnvState
} from './environments'

function twoEnvs(): EnvState {
  let state = emptyEnvs()
  state = addEnv(state, '测试').state
  state = upsertVar(state, '测试', 'gw', '10.0.0.1')
  state = upsertVar(state, '测试', 'token', 't-test')
  state = upsertVar(state, DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
  return state
}

describe('环境增删改', () => {
  it('初始就有一个默认环境并且是激活的', () => {
    const s = emptyEnvs()
    expect(s.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME])
    expect(s.activeName).toBe(DEFAULT_ENV_NAME)
    expect(varsFor(s)).toEqual({})
  })

  it('重名环境加序号，不静默覆盖', () => {
    let s = emptyEnvs()
    s = addEnv(s, '生产').state
    s = addEnv(s, '生产').state
    expect(s.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME, '生产', '生产 (2)'])
    expect(uniqueEnvName(s, '  ')).toBe('未命名环境')
  })

  it('改名时变量跟着走；改的是激活环境就一起改，不会把人甩出当前环境', () => {
    const s = twoEnvs()
    const renamed = renameEnv(s, DEFAULT_ENV_NAME, '本地')
    expect(renamed.activeName).toBe('本地')
    expect(renamed.environments.find((e) => e.name === '本地')?.variables.map((v) => v.key)).toEqual(['gw'])
  })

  it('改成已有名字会撞车 → 自动加序号；改成空串不改', () => {
    const s = twoEnvs()
    expect(renameEnv(s, DEFAULT_ENV_NAME, '测试').environments.map((e) => e.name)).toEqual(['测试 (2)', '测试'])
    expect(renameEnv(s, DEFAULT_ENV_NAME, '   ')).toBe(s)
  })

  it('删掉激活环境后没有激活环境，而不是随便挑一个', () => {
    const s = setActive(twoEnvs(), '测试')
    const after = removeEnv(s, '测试')
    expect(after.activeName).toBeNull()
    expect(after.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME])
  })

  it('切到一个不存在的环境名会被挡住', () => {
    const s = twoEnvs()
    expect(setActive(s, '没有这个环境')).toBe(s)
  })
})

describe('变量分层（core 的语义，界面必须照这个说法）', () => {
  it('激活环境覆盖其他环境的同名变量，其他环境的独有条目仍然兜底', () => {
    let s = emptyEnvs()
    s = addEnv(s, '测试').state
    s = upsertVar(s, '测试', 'gw', '10.0.0.1')
    s = upsertVar(s, DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
    s = upsertVar(s, DEFAULT_ENV_NAME, 'only', 'base')

    expect(varsFor(setActive(s, '测试'))).toEqual({ gw: '10.0.0.1', only: 'base' })
    expect(varsFor(setActive(s, DEFAULT_ENV_NAME))).toEqual({ gw: '127.0.0.1', only: 'base' })
  })

  it('没有激活环境 = 一个变量都不替换（不能把全部环境混一起当兜底）', () => {
    const s = twoEnvs()
    expect(varsFor(setActive(s, null))).toEqual({})
  })

  it('勾选关掉（enabled=false）的变量不参与替换，也不参与来源判定', () => {
    let s = emptyEnvs()
    s = upsertVar(s, DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
    s = upsertVar(s, DEFAULT_ENV_NAME, 'off', 'nope', false)
    expect(varsFor(s)).toEqual({ gw: '127.0.0.1' })
    expect(varOrigin(s, 'off')).toBeNull()
  })

  it('varOrigin 说清这条值是谁给的', () => {
    const s = setActive(twoEnvs(), '测试')
    expect(varOrigin(s, 'gw')).toBe('测试')
    let only = removeVar(s, '测试', 'gw')
    only = upsertVar(only, DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
    expect(varOrigin(setActive(only, '测试'), 'gw')).toBe(DEFAULT_ENV_NAME)
    expect(varOrigin(only, '不存在')).toBeNull()
  })
})

describe('upsertVar / removeVar', () => {
  it('同键覆盖值，不产生第二条重复项', () => {
    let s = emptyEnvs()
    s = upsertVar(s, DEFAULT_ENV_NAME, 'token', 'a')
    s = upsertVar(s, DEFAULT_ENV_NAME, 'token', 'b')
    expect(s.environments[0]?.variables).toEqual([{ key: 'token', value: 'b', enabled: true }])
  })

  it('空键名不入库', () => {
    expect(upsertVar(emptyEnvs(), DEFAULT_ENV_NAME, '   ', 'x').environments[0]?.variables).toEqual([])
  })

  it('删不存在的环境/变量都原样返回', () => {
    const s = emptyEnvs()
    expect(removeVar(s, '没有这个环境', 'gw')).toBe(s)
  })
})

describe('变量表格的行列策略', () => {
  function env(variables: Environment['variables']): Environment {
    return { name: DEFAULT_ENV_NAME, variables }
  }

  it('命令里用到但环境没有的变量以空值占位行出现', () => {
    const rows = rowsForEditor(env([{ key: 'gw', value: '10.0.0.1', enabled: true }]), ['token', 'gw'])
    expect(rows).toEqual([
      { key: 'gw', value: '10.0.0.1', enabled: true },
      { key: 'token', value: '', enabled: true }
    ])
  })

  it('没有激活环境就是空表，不替用户编一个', () => {
    expect(rowsForEditor(undefined, ['gw'])).toEqual([])
  })

  it('占位行没填值就不入库；环境里本来就在的空值继续保留', () => {
    const base = env([
      { key: 'gw', value: '', enabled: true },
      { key: 'blank', value: '', enabled: true }
    ])
    const rows = rowsForEditor(base, ['fresh'])
    expect(commitRows(base, rows)).toEqual([
      { key: 'gw', value: '', enabled: true },
      { key: 'blank', value: '', enabled: true }
    ])
  })

  it('键名去空格；空键行直接丢；同名重复行只留最后编辑的那个值', () => {
    const base = env([])
    const rows: Environment['variables'] = [
      { key: '  a  ', value: '1', enabled: true },
      { key: '', value: '忽略我', enabled: true },
      { key: 'b', value: 'first', enabled: true },
      { key: 'b', value: 'last', enabled: false }
    ]
    expect(commitRows(base, rows)).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'last', enabled: false }
    ])
  })
})

describe('从 M1 的扁平 vars 迁移', () => {
  it('旧值并进默认环境，一个不丢', () => {
    const { state, migrated, conflicts } = migrateLegacyVars(emptyEnvs(), { gw: '10.0.0.9', token: 'abc' })
    expect(migrated).toBe(2)
    expect(conflicts).toEqual([])
    expect(varsFor(state)).toEqual({ gw: '10.0.0.9', token: 'abc' })
  })

  it('没有旧数据就什么都不动（不给状态树制造无谓的新对象）', () => {
    const s = emptyEnvs()
    expect(migrateLegacyVars(s, {}).state).toBe(s)
    expect(migrateLegacyVars(s, null).migrated).toBe(0)
  })

  it('同名且值不同：保留环境里已有的，把冲突名字报出来给用户看', () => {
    let s = emptyEnvs()
    s = upsertVar(s, DEFAULT_ENV_NAME, 'gw', '127.0.0.1')
    const r = migrateLegacyVars(s, { gw: '10.0.0.9', fresh: 'keep' })
    expect(r.migrated).toBe(1)
    expect(r.conflicts).toEqual(['gw'])
    expect(varsFor(r.state)).toEqual({ gw: '127.0.0.1', fresh: 'keep' })
  })

  it('默认环境已经被删掉时，迁移会把它建回来', () => {
    const s = removeEnv(emptyEnvs(), DEFAULT_ENV_NAME)
    const r = migrateLegacyVars(s, { a: '1' })
    expect(r.state.environments.map((e) => e.name)).toContain(DEFAULT_ENV_NAME)
  })
})

describe('导入集合里的环境', () => {
  const incoming: Environment[] = [
    { name: '生产', variables: [{ key: 'gw', value: 'prod.example.com', enabled: true }] },
    { name: DEFAULT_ENV_NAME, variables: [{ key: 'x', value: '1', enabled: true }] }
  ]

  it('同名环境改加序号入库，并在返回值里说清原名', () => {
    const { state, added } = mergeEnvironments(twoEnvs(), incoming)
    expect(state.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME, '测试', '生产', `${DEFAULT_ENV_NAME} (2)`])
    expect(added).toEqual(['生产', `默认 (2)（原名 默认）`])
  })

  it('不会改动激活环境', () => {
    const s = setActive(twoEnvs(), '测试')
    expect(mergeEnvironments(s, incoming).state.activeName).toBe('测试')
  })
})

describe('sanitizeEnvState（localStorage 里的坏数据不能把开机搞崩）', () => {
  it('形状不对就当没存过，回到默认环境', () => {
    for (const bad of [undefined, null, 42, '字符串', {}, { environments: 'nope' }, { environments: [] }]) {
      const s = sanitizeEnvState(bad)
      expect(s.environments.map((e) => e.name)).toEqual([DEFAULT_ENV_NAME])
      expect(s.activeName).toBe(DEFAULT_ENV_NAME)
    }
  })

  it('丢掉没名字 / 重名的环境与没键名的变量，值类型不对的补空串', () => {
    const s = sanitizeEnvState({
      environments: [
        null,
        { name: '  ', variables: [] },
        { name: '生产', variables: [{ key: 'gw', value: 123 }, { key: '' }, 42, { key: 'gw', value: 'dup' }] },
        { name: '生产', variables: [{ key: 'x', value: '1' }] }
      ],
      activeName: '生产'
    })
    expect(s.environments.map((e) => e.name)).toEqual(['生产'])
    expect(s.environments[0]?.variables).toEqual([{ key: 'gw', value: '', enabled: true }])
    expect(s.activeName).toBe('生产')
  })

  it('激活环境指向一个不存在的环境时置空，而不是随机挑一个', () => {
    const s = sanitizeEnvState({ environments: [{ name: '生产', variables: [] }], activeName: '已经删掉了' })
    expect(s.activeName).toBeNull()
  })

  it('enabled: false 要留着（关掉的变量不参与替换）', () => {
    const s = sanitizeEnvState({ environments: [{ name: 'A', variables: [{ key: 'k', value: 'v', enabled: false }] }], activeName: 'A' })
    expect(s.environments[0]?.variables).toEqual([{ key: 'k', value: 'v', enabled: false }])
  })
})
