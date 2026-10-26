import type { Param } from '@curlviz/core'

interface Props {
  rows: Param[]
  onChange: (rows: Param[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  /** header 表用冒号语法更贴近 curl，query 表用等号。仅影响表头文字。 */
  pairLabel?: string
}

/**
 * query / header / form 三张表共用一套编辑器。
 * 空行永远留在末尾：用户点"添加"后不该再去找光标在哪。
 */
export function KeyValueTable({ rows, onChange, keyPlaceholder, valuePlaceholder, pairLabel = '键 / 值' }: Props) {
  const set = (i: number, patch: Partial<Param>): void => {
    onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  }
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
          {rows.map((r, i) => (
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
                <input
                  value={r.key}
                  placeholder={keyPlaceholder}
                  onChange={(e) => set(i, { key: e.target.value })}
                  aria-label="名称"
                />
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
                <button className="mini" onClick={() => remove(i)} title="删除这一行">
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="mini"
        style={{ marginTop: '0.4rem' }}
        onClick={() => onChange([...rows, { key: '', value: '', enabled: true }])}
      >
        ＋ 添加一行
      </button>
    </div>
  )
}
