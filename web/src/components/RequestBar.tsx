import { useEffect, useRef, useState } from 'react'
import { KNOWN_METHODS } from '@curlviz/core'
import type { SendActionId, SendMenu } from '../lib/send-actions'
import { sendBadge } from '../lib/send-actions'

interface Props {
  name: string
  method: string
  url: string
  sending: boolean
  canSend: boolean
  /** 判定结果：这条要不要发预检（fetch-rules 算的）。只用来点亮徽标，不当结论用。 */
  preflightExpected: boolean
  /** 徽标悬停时说的完整一句。 */
  preflightReason: string
  menu: SendMenu
  /** "编辑自「某集合」的 某条请求"，没有就是 null。 */
  boundNote: string | null
  onName: (value: string) => void
  onMethod: (value: string) => void
  onUrl: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onAction: (id: SendActionId) => void
}

/**
 * 请求行：这个工具的主操作区，所以它是页面上唯一一行"高控件"。
 *
 * 与 Postman 的差别是刻意的：
 *  - 方法用可输入的 combobox 而不是下拉。curl 不限制动词（PROPFIND、REPORT 都合法），
 *    Postman 要选 "Custom" 再另开一个框输入，这里一个框就写完。
 *  - 「新建 / 导入 / 集合 / 环境 / 分享」都挪到左侧操作栏，这一行只留"改地址 + 发出去"。
 *  - 发送是分裂按钮：主按钮走浏览器，▾ 里全是"复制到终端"的几种形态——
 *    因为跨域预检这条路我们已经实测过很多网关根本没实现，终端才是稳的路。
 */
export function RequestBar(props: Props) {
  const { name, method, url, sending, canSend, preflightExpected, preflightReason, menu, boundNote } = props
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const caretRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      // 关完把焦点还给那颗 ▾：还给 body 的话键盘用户得从头 Tab 一遍
      caretRef.current?.focus()
    }
    // capture 阶段听：菜单里的项自己会处理点击，冒泡上来再被这里判成"点外面"就关错了
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const badge = sendBadge(preflightExpected)

  return (
    <section className="card req">
      <div className="req-title">
        <input
          className="doc-name"
          value={name}
          placeholder="未命名请求"
          aria-label="请求名称"
          spellCheck={false}
          onChange={(e) => props.onName(e.target.value)}
        />
        {boundNote && (
          <span className="muted ellip" title={boundNote}>
            {boundNote}
          </span>
        )}
        {badge !== '' && (
          <span className="chip warn" title={preflightReason}>
            {badge}
          </span>
        )}
        <span className="grow" />
        <span className="muted keys">Ctrl+Enter 发送</span>
      </div>

      <div className="req-bar">
        <input
          className="method"
          list="curlviz-methods"
          value={method}
          aria-label="方法（可直接输入，如 PROPFIND）"
          title="curl 不限制方法名，直接改就行"
          spellCheck={false}
          onChange={(e) => props.onMethod(e.target.value.trim().toUpperCase() || 'GET')}
        />
        <datalist id="curlviz-methods">
          {KNOWN_METHODS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <input
          className="url grow"
          value={url}
          placeholder="https://internal.api/v1/list"
          aria-label="URL"
          spellCheck={false}
          onChange={(e) => props.onUrl(e.target.value)}
        />

        {/*
          URL 没填用 aria-disabled 而非原生 disabled：原生 disabled 吃掉指针事件，
          title 悬停在真实浏览器里根本不弹（这轮就是把提示挪到悬停）。
          所以让它照常可悬停可聚焦，只在 onClick 挡住发送，.is-off 复刻禁用外观。
        */}
        <div className="send-split" ref={wrapRef}>
          <button
            type="button"
            className={sending ? 'primary danger' : canSend ? 'primary' : 'primary is-off'}
            aria-disabled={!sending && !canSend ? 'true' : undefined}
            title={!sending && !canSend ? '填了 URL 才能发送' : undefined}
            onClick={sending ? props.onCancel : () => void (canSend && props.onSend())}
          >
            {sending ? '取消' : '发送'}
          </button>
          <button
            type="button"
            className="primary send-caret"
            ref={caretRef}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="复制与发送选项"
            title="复制到终端的几种形态"
            onClick={() => setOpen((v) => !v)}
          >
            ▾
          </button>

          {open && (
            <div className="menu" role="menu" aria-label="复制与发送选项">
              {menu.note !== null && <p className="menu-note">{menu.note}</p>}
              {menu.items.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  autoFocus={i === 0}
                  onClick={() => {
                    setOpen(false)
                    props.onAction(item.id)
                  }}
                >
                  <span className="menu-label">{item.label}</span>
                  <span className="menu-hint">{item.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default RequestBar
