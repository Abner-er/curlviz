import { useEffect, useRef, useState } from 'react'

export interface TransportOption {
  id: string
  name: string
  /** 当前会话里这台是否已填过 token。没填也能选，但发送会被执行机拒（不编造发得出去）。 */
  hasToken: boolean
}

interface Props {
  /** 当前选中的执行机 id；null = 走浏览器 fetch。 */
  activeId: string | null
  options: TransportOption[]
  onSelect: (id: string | null) => void
  onManage: () => void
}

/**
 * 发送路径选择器：一条命令到底走浏览器 fetch，还是走某台执行机上的真 curl。
 *
 * 放在发送旁边而不是塞进某个设置页，是因为这是每次发送前都该看得见的一件事——
 * 跨域被拦的运维，需要的恰恰是"换条路再发一次"，那个入口必须在手边。
 * 弹出层复用 .menu（发送 ▾ 那颗同一套），不另立样式。
 */
export function TransportPicker({ activeId, options, onSelect, onManage }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    // capture 阶段听：菜单项自己会处理点击，冒泡上来会被判成"点外面"而关错
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = options.find((o) => o.id === activeId) ?? null
  const needsToken = active !== null && !active.hasToken
  const label = active ? active.name : '浏览器'
  const baseTitle = active
    ? `当前经执行机「${active.name}」上的真 curl 发送：-k / --resolve / 原始参数都照常生效。点这切换。`
    : '当前经浏览器 fetch 发送（受跨域限制）。点这切换成某台执行机上的真 curl。'

  return (
    <div className="transport" ref={wrapRef}>
      <button
        type="button"
        className={needsToken ? 'chip warn transport-btn' : 'chip transport-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        title={needsToken ? `${baseTitle}这台还没填 token，发送会被拒。` : baseTitle}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="transport-tag">{active ? '执行机' : '浏览器'}</span>
        <span className="ellip transport-name">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="menu" role="menu" aria-label="选择发送路径">
          <p className="menu-note">
            浏览器这条路受同源策略限制；执行机上的真 curl 不受限，也能发 -k / --resolve 这类浏览器发不出的东西。
          </p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={activeId === null}
            autoFocus={activeId === null}
            onClick={() => {
              setOpen(false)
              onSelect(null)
            }}
          >
            <span className="menu-label">浏览器（本机 fetch）</span>
            <span className="menu-hint">受跨域限制，只发浏览器允许的头</span>
          </button>
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={activeId === o.id}
              autoFocus={i === 0 && activeId !== null}
              onClick={() => {
                setOpen(false)
                onSelect(o.id)
              }}
            >
              <span className="menu-label">{o.name}</span>
              <span className="menu-hint">{o.hasToken ? '经这台的真 curl 发送' : '未填 token · 发送会被拒'}</span>
            </button>
          ))}
          {options.length === 0 && <p className="menu-note">还没有执行机，点下面「管理执行机…」加一台 ECS 上的 agent。</p>}
          <button
            type="button"
            role="menuitem"
            className="transport-manage"
            onClick={() => {
              setOpen(false)
              onManage()
            }}
          >
            <span className="menu-label">管理执行机…</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default TransportPicker
