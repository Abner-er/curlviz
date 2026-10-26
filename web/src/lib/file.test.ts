import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_BYTES, safeFileName } from './file'

describe('safeFileName', () => {
  it('Windows 不许的字符逐个替掉', () => {
    expect(safeFileName(['a/b:c*d?e|f'], '.json')).toBe('a_b_c_d_e_f.json')
    expect(safeFileName(['g"h<i>j'], '.json')).toBe('g_h_i_j.json')
    // 相邻两个非法字符各替一个下划线，不合并
    expect(safeFileName(['d?"e'], '.json')).toBe('d__e.json')
  })

  it('空片段与全空名字退回默认名，不产出 ".json" 这种没主儿的文件', () => {
    expect(safeFileName(['', '   '], '.json')).toBe('curlviz.json')
    expect(safeFileName(['集合', '生产'], '.json')).toBe('集合_生产.json')
  })

  it('超长名字截断（路径太深某些同步盘会翻车），但扩展名保住', () => {
    const long = safeFileName(['x'.repeat(300)], '.json')
    expect(long.length).toBeLessThanOrEqual(80 + '.json'.length)
    expect(long.endsWith('.json')).toBe(true)
  })

  it('导入体积上限 4MB', () => {
    expect(MAX_IMPORT_BYTES).toBe(4 * 1024 * 1024)
  })
})
