import type { HistoryEntry } from '../types'
import { generateCurl } from '@curlviz/core'
import { historySummary } from '../lib/display'

interface Props {
  items: HistoryEntry[]
  quoteStyle: 'posix' | 'windows'
  multiline: boolean
  /** 历史与导出是否默认脱敏。开关放这块而不是顶栏：它只影响看得见的这一列。 */
  redactHistory: boolean
  onRedactHistory: (value: boolean) => void
  onPick: (entry: HistoryEntry) => void
  onDelete: (id: string) => void
  onClear: () => void
}

export function HistoryPanel({
  items,
  quoteStyle,
  multiline,
  redactHistory,
  onRedactHistory,
  onPick,
  onDelete,
  onClear
}: Props) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>历史（最近 {items.length} 条，只存这台机器）</h2>
        <span className="grow" />
        <label className="inline-chk" title="关掉之后历史与导出会原样存 Authorization / Cookie，只在你自己机器上">
          <input type="checkbox" checked={redactHistory} onChange={(e) => onRedactHistory(e.target.checked)} />
          脱敏
        </label>
      </div>
      {items.length === 0 && <p className="muted">发送成功后会自动记一条。默认脱敏，密码与 token 不入库。</p>}
      <ul className="history">
        {items.map((e) => (
          <li key={e.id}>
            <button className="mini" onClick={() => onPick(e)} title="点一下回填到编辑器">
              取回
            </button>
            <span className="u">
              {generateCurl(e.spec, { quoteStyle, multiline }).split('\n')[0]}
            </span>
            <span className="muted">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span className="muted">{historySummary(e)}</span>
            {e.redacted && <span className="muted" title="已脱敏">🔒</span>}
            <button className="mini" onClick={() => onDelete(e.id)} title="删掉这条">
              ✕
            </button>
          </li>
        ))}
      </ul>
      {items.length > 0 && (
        <button className="mini" style={{ marginTop: '0.5rem' }} onClick={onClear}>
          清空历史
        </button>
      )}
    </section>
  )
}
