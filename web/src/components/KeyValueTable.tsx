import type { Param } from '@curlviz/core'
import type { RowNote } from '../lib/display'
import { applyRowEdit, needsDraftRow } from '../lib/kv-rows'

/** 草稿行的形状。整张表共用一个常量：只读，写的时候一律展开成新对象。 */
const BLANK: Param = { key: '', value: '', enabled: true }

interface Props {
  rows: Param[]
  onChange: (rows: Param[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  /** header 表用冒号语法更贴近 curl，query 表用等号。仅影响表头文字。 */
  pairLabel?: string
  /**
   * 某一行的"特殊语义"胶囊。返回 null 就不画。
   * 用在两处都能要命的地方：`--url-query` 来的项（生成时不折进 URL），
   * 和值为空的头（curl 里 `-H 'K:'` 是**删头**，不是发空值头 —— 实测）。
   * 光看输入框看不出来，用户会以为自己写的是"值为空的头"。
   */
  rowNote?: (row: Param) => RowNote | null
}

/**
 * query / header / form 三张表共用一套编辑器。
 *
 * 末行永远是空行，不用先点"＋ 添加一行"再打字（旧版那句注释是这么承诺的，实现却要点按钮）。
 * 草稿行不进数据：打字那一刻才追加成真行，所以页签上的计数、等价 curl、
 * 存进集合的东西都不会被一行空白污染。
 */
export function KeyValueTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  pairLabel = '键 / 值',
  rowNote
}: Props) {
  // 末行已经是一行空行就拿它当草稿，不再补一行：否则表尾永远多一格看不懂的空白
  const body: Param[] = needsDraftRow(rows) ? [...rows, BLANK] : rows

  const set = (i: number, patch: Partial<Param>): void => onChange(applyRowEdit(rows, i, BLANK, patch))
  const remove = (i: number): void => onChange(rows.filter((_, k) => k !== i))

  return (
    <div>
      <table className="kv">
        <thead>
          <tr>
            <th style={{ width: '2.2rem' }} title="勾选才发送">
              发
            </th>
            <th>{pairLabel.split(' / ')[0] ?? '键'}</th>
            <th>{pairLabel.split(' / ')[1] ?? '值'}</th>
            <th style={{ width: '3rem' }} />
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => {
            const note = rowNote?.(r) ?? null
            // 草稿行不在 rows 里，也就没有"删掉它"这回事：它下一格就是新的草稿行
            const real = i < rows.length
            return (
              <tr key={i}>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => set(i, { enabled: e.target.checked })}
                    aria-label={`发送第 ${i + 1} 行`}
                  />
                </td>
                <td>
                  <div className="kv-key">
                    <input
                      value={r.key}
                      placeholder={keyPlaceholder}
                      onChange={(e) => set(i, { key: e.target.value })}
                      aria-label="名称"
                    />
                    {note !== null && (
                      <span className="tag-mini" title={note.title}>
                        {note.text}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <input
                    value={r.value}
                    placeholder={valuePlaceholder}
                    onChange={(e) => set(i, { value: e.target.value })}
                    aria-label="值"
                  />
                </td>
                <td>
                  {real && (
                    <button className="mini" onClick={() => remove(i)} title="删除这一行">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
