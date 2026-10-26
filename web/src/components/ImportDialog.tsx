import { useState } from 'react'
import { Overlay } from './Overlay'

interface Props {
  /** 返回 null 表示导入成功（父组件已经把 spec 换掉了）；返回字符串是给人看的失败原因。 */
  onImport: (text: string) => string | null
  onClose: () => void
}

/**
 * 粘贴 curl 导入弹窗。
 *
 * 两条老规矩留着：
 *  - 刻意不做"边输边解析"：粘一半时解析结果是错的，用户会以为命令坏了；
 *  - 失败留在弹窗里改：原文还在框中，改一个引号再试一次比重新粘一遍省事。
 *
 * 改成弹窗后丢了一条：原来面板内联，解析成功后原文与表单同屏，能对拍
 * "跟我原来那条到底差在哪"。现在成功就关框，对照只能靠表单里的告警条与
 * 「选项」页里原样留下的 flag —— 拿同屏对拍换整屏工作区，这笔账记在这儿。
 */
export function ImportDialog({ onImport, onClose }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const err = onImport(text)
    if (err === null) onClose()
    else setError(err)
  }

  return (
    <Overlay label="粘贴 curl 导入" onClose={onClose} initialFocus="field">
      <h2>粘贴 curl 导入</h2>
      <p className="muted">整条命令贴进来就行，续行、注释、引号嵌套都认；认不出的 flag 原样留在「选项」页里。</p>
      <textarea
        rows={10}
        value={text}
        spellCheck={false}
        aria-label="curl 命令原文"
        placeholder={"curl 'https://internal/api/v1/list' \\\n  -H 'Authorization: Bearer xxx' \\\n  --data-raw '{\"page\":1}'"}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          // Ctrl+Enter 当场解析。全局那个"Ctrl+Enter 发送"在弹层开着时不响应（见 hooks/useSend），
          // 否则这一次按键会把编辑器里那条旧命令一起发出去
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            if (text.trim() !== '') submit()
          }
        }}
      />
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="primary" onClick={submit} disabled={text.trim() === ''}>
          解析并填入表单
        </button>
        <button onClick={onClose}>取消</button>
        <span className="muted">Ctrl+Enter 解析；填入后原命令文本不保留，要对照就再粘一次。</span>
      </div>
      {error && (
        <ul className="notes">
          <li className="err">{error}</li>
        </ul>
      )}
    </Overlay>
  )
}
