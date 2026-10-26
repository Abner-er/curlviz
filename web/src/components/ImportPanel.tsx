import { useState } from 'react'

interface Props {
  /** 返回 null 表示导入成功（父组件已经把 spec 换掉了）；返回字符串是给人看的失败原因。 */
  onSubmit: (text: string) => string | null
  onClose: () => void
}

/**
 * 粘贴导入。刻意不做"边输边解析"：粘一半时解析结果是错的，用户会以为命令坏了。
 * 解析成功后保留原文，方便对拍——毕竟运维习惯是"跟我原来那条到底差在哪"。
 */
export function ImportPanel({ onSubmit, onClose }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <section className="card">
      <h2>粘贴 curl 导入</h2>
      <textarea
        rows={8}
        value={text}
        spellCheck={false}
        placeholder={"curl 'https://internal/api/v1/list' \\\n  -H 'Authorization: Bearer xxx' \\\n  --data-raw '{\"page\":1}'"}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
      />
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button
          className="primary"
          onClick={() => setError(onSubmit(text))}
          disabled={text.trim() === ''}
        >
          解析并填入表单
        </button>
        <button onClick={onClose}>收起</button>
        <span className="muted">支持多行续行、注释、引号嵌套；认不出的 flag 会原样保留在「选项」页里。</span>
      </div>
      {error && (
        <ul className="notes">
          <li className="err">{error}</li>
        </ul>
      )}
    </section>
  )
}
