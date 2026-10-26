import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { cycleIndex, FOCUSABLE_SELECTOR } from '../lib/focus'
import { enterLayer, isTopLayer, layerCount, leaveLayer } from '../lib/layers'

/**
 * 弹层（居中的弹窗 / 贴边的抽屉）共用的那套焦点与宿主处理。
 *
 * 为什么要有这个 hook：抽屉里点「分享」会再开一个弹窗，两个弹层各写一遍焦点进出与
 * Escape，就会出现两种只在叠加时才暴露的错 —— 按一次 Esc 把两层一起关掉，
 * 以及"关里层时把外层还锁着的背景一起解锁"。共用一份之后，新增弹层不必再决定这些。
 *
 * 这里只剩 DOM 的活：列表算术在 lib/focus 的 cycleIndex 里，叠放次序在 lib/layers 里，
 * 两边都已经脱离浏览器测过。
 */
export type InitialFocus =
  /** 焦点落在容器自己（tabIndex=-1）：读屏当场念出弹层标题。默认这个 */
  | 'container'
  /** 焦点落在里面第一个可用控件：粘贴导入这种"打开就是往里打字"的弹窗少按两下 */
  | 'field'

export interface ModalShell {
  ref: RefObject<HTMLDivElement>
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
}

/**
 * 背景锁。
 *
 * 锁不锁看 lib/layers 里"还开着几层"，不看布尔：里层退出时外层仍然开着，背景必须继续锁住。
 */
function setBackgroundInert(): void {
  // 老浏览器不认 inert：退化成只靠下面的 Tab 圈定 —— 焦点照样出不去，
  // 只是背景还能点、还能被读屏念到。不影响把活干完，就不为它补 polyfill
  if (!('inert' in HTMLElement.prototype)) return
  const root = document.getElementById('root')
  if (root === null) return
  if (layerCount() > 0) root.setAttribute('inert', '')
  else root.removeAttribute('inert')
}

/**
 * 弹层里"能被 Tab 走到"的那些。
 *
 * disabled 与看不见的人都拿不到焦点：把他们算进序列会让 Tab 从圈里漏出去，
 * 也会让 initialFocus='field' 落到一个根本打不了字的按钮上。
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0
  )
}

export function useModalShell(onClose: () => void, initialFocus: InitialFocus = 'container'): ModalShell {
  const ref = useRef<HTMLDivElement>(null)
  /**
   * onClose 每次渲染都是新的闭包，而 effect 只在挂载那一次跑。
   * 转存一份，Escape 处理的闭包里读到的才是"当下这个" onClose ——
   * 直接读 onClose 会把首屏那一份永久钉在监听器上。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  /** 叠放令牌。一个弹层实例一辈子一枚，创建后不再换 —— 换了就对不上栈里那一枚。 */
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('overlay')

  useEffect(() => {
    const token = tokenRef.current as symbol
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    enterLayer(token)
    setBackgroundInert()
    const items = ref.current === null ? [] : focusableIn(ref.current)
    if (initialFocus === 'field' && items.length > 0) items[0]?.focus()
    else ref.current?.focus()
    return () => {
      leaveLayer(token)
      setBackgroundInert()
      // 交还焦点：不还就掉回文档开头，键盘用户想接着操作得从头 Tab 几十下。
      // 唤起者可能已经被重渲染换掉（集合列表刷新后那一行没了），那就别硬 focus 一个不在文档里的节点
      if (opener !== null && document.contains(opener)) opener.focus()
    }
    // initialFocus 是弹层的固有属性，不会在开着的期间变，所以只挂一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 挂在 window 而不是容器上：焦点一时在容器、一时在里面某个按钮，
      // 靠冒泡到容器这条路在容器没拿到焦点时是断的。
      // 代价是每层都收得到，所以只让最上面那层动手 —— 抽屉里开着分享弹窗时按 Esc，
      // 该消失的是弹窗，抽屉要留着，否则用户按下 Esc 发现自己整个库都没了
      const token = tokenRef.current
      if (token !== null && isTopLayer(token)) closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || ref.current === null) return
    const items = focusableIn(ref.current)
    const next = cycleIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey ? -1 : 1)
    if (next < 0) return
    e.preventDefault()
    items[next]?.focus()
  }

  return { ref, onKeyDown }
}
