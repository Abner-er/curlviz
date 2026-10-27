import { useMemo, useState } from 'react'
import type { ParseWarning, QuoteStyle } from '@curlviz/core'
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
  quoteStyle: QuoteStyle
  multiline: boolean
  onQuoteStyle: (style: QuoteStyle) => void
  onMultiline: (value: boolean) => void
  /** 折叠状态由外面管（要持久化），这里只画。 */
  open: boolean
  onToggle: (open: boolean) => void
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

/**
 * 等价 curl：这个工具的"另一半输出"。
 *
 * 做成可折叠的 dock 而不是无限长的卡片：10 行的命令就要 427px 高（实测），
 * 比响应区还占地方，而它多数时候只是"扫一眼对不对"。
 * 折叠后仍留着「复制到终端」与提醒计数——收起正文不该把主动作也收走。
 */
export function CurlPreview({
  curl,
  warnings,
  preNotices = [],
  quoteStyle,
  multiline,
  onQuoteStyle,
  onMultiline,
  open,
  onToggle
}: Props) {
  const [toast, setToast] = useState('')
  const lines = useMemo(() => curl.split('\n').length, [curl])
  const noticeCount = warnings.length + preNotices.length

  const doCopy = async (): Promise<void> => {
    const ok = await copyText(curl)
    setToast(ok ? '已复制，可直接粘到终端' : '浏览器不让写剪贴板，请手动全选复制')
    setTimeout(() => setToast(''), 2200)
  }

  return (
    <section className="card curl-dock">
      <div className="dock-head">
        <button type="button" className="dock-toggle" aria-expanded={open} aria-controls="curl-body" onClick={() => onToggle(!open)}>
          <span className="caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          等价 curl（{lines} 行）
        </button>

        {!open && noticeCount > 0 && (
          // 折叠时提醒不能跟着消失，否则"收起"就变成了"别看问题"
          <button type="button" className="chip warn" onClick={() => onToggle(true)}>
            {noticeCount} 条提醒
          </button>
        )}

        <span className="grow" />

        <div className="seg" role="group" aria-label="引号风格">
          <button
            type="button"
            className="seg-btn"
            aria-pressed={quoteStyle === 'posix'}
            title="bash / Git-Bash / WSL / macOS 用单引号"
            onClick={() => onQuoteStyle('posix')}
          >
            POSIX
          </button>
          <button
            type="button"
            className="seg-btn"
            aria-pressed={quoteStyle === 'windows'}
            title="cmd.exe 不认 POSIX 那套 '\\'' 引号，粘过去就是坏命令"
            onClick={() => onQuoteStyle('windows')}
          >
            cmd.exe
          </button>
        </div>
        <label className="inline-chk" title="每行一个参数，带 \\ 续行；关掉就是一条单行命令">
          <input type="checkbox" checked={multiline} onChange={(e) => onMultiline(e.target.checked)} />
          多行
        </label>

        <button type="button" className="primary" onClick={() => void doCopy()}>
          复制到终端
        </button>
      </div>

      {open && (
        <div id="curl-body" className="dock-body">
          <pre className="code">{curl}</pre>
        </div>
      )}

      {open && noticeCount > 0 && (
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
