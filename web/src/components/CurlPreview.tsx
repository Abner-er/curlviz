import { useMemo, useState } from 'react'
import type { ParseWarning } from '@curlviz/core'
import { copyText } from '../lib/clipboard'

interface Props {
  curl: string
  warnings: ParseWarning[]
  /**
   * 发送前就该看见的提醒（跨域预检是其中一条）。放这里而不是等点完发送才在结果区冒出来：
   * 预检被拦时命令本身没错，让人白点一次发送、再去翻控制台，不如提前一句话说清"浏览器这条路不通"。
   */
  preNotices?: string[]
  /** 目标终端是 Windows 时提示引号风格，POSIX 引号粘进 cmd.exe 就是坏命令。 */
  quoteStyle: 'posix' | 'windows'
  onFixQuoteStyle: () => void
}

const WARNING_LABEL: Record<ParseWarning['code'], string> = {
  'shell-substitution': '含 shell 变量/命令替换',
  'multiple-commands': '一条里有多个 curl',
  'unknown-flag': '未识别的 flag',
  'extra-url': '多个 URL',
  'data-urlencode-lossy': '--data-urlencode 近似映射',
  malformed: '结构不完整',
  'flag-conflict': 'flag 语义冲突'
}

export function CurlPreview({ curl, warnings, preNotices = [], quoteStyle, onFixQuoteStyle }: Props) {
  const [toast, setToast] = useState('')
  const lines = useMemo(() => curl.split('\n').length, [curl])

  const doCopy = async (): Promise<void> => {
    const ok = await copyText(curl)
    setToast(ok ? '已复制，可直接粘到终端' : '浏览器不让写剪贴板，请手动全选复制')
    setTimeout(() => setToast(''), 2200)
  }

  return (
    <section className="card">
      <h2>等价 curl（{lines} 行）</h2>
      <pre className="code">{curl}</pre>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="primary" onClick={doCopy}>
          复制到终端
        </button>
        {quoteStyle === 'posix' && /["']/.test(curl) && (
          <button className="mini" onClick={onFixQuoteStyle} title="cmd.exe 不认 '\\'' 这套 shell 引号">
            在 cmd.exe 里跑不通？切 Windows 引号
          </button>
        )}
        <span className="muted">引号风格：{quoteStyle === 'windows' ? 'Windows（双引号）' : 'POSIX（单引号）'}</span>
      </div>

      {(warnings.length > 0 || preNotices.length > 0) && (
        /* 合成一个列表：两个外观相同的 ul.notes 上下叠着，看着像组件画重了 */
        <ul className="notes">
          {warnings.map((w, i) => (
            <li key={`w${i}`}>
              <b>{WARNING_LABEL[w.code] ?? w.code}</b>：{w.message}
            </li>
          ))}
          {preNotices.map((n, i) => (
            <li key={`p${i}`}>{n}</li>
          ))}
        </ul>
      )}
      {toast !== '' && <div className="toast">{toast}</div>}
    </section>
  )
}
