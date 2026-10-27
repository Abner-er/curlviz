import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { clampSplit, edgeSplit, orientationFor, splitFromPointer, stepSplit, type SplitOrientation } from '../lib/split'

/**
 * 分栏比例的接线层：指针拖、键盘调、双击复位，算术全在 lib/split.ts（那边有单测）。
 * 这里只做事件与 DOM 测量，node 环境测不到——所以刻意不在这儿放任何判断。
 */

export interface SplitHandle {
  ratio: number
  dragging: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
  onDoubleClick: () => void
}

export function useSplit(opts: {
  /** 初值来自持久化的设置，坏值由 clampSplit 收敛。 */
  initial: number
  /** 拖完 / 按完写回设置。松手才写，避免每像素一次 localStorage。 */
  onCommit: (ratio: number) => void
  orientation: SplitOrientation
}): SplitHandle {
  const [ratio, setRatio] = useState(() => clampSplit(opts.initial))
  const [dragging, setDragging] = useState(false)
  /*
   * 事件回调里要读"当前"比例，不能读闭包里的旧值：pointermove 每次都在旧值上做换算的话，
   * 一次拖拽就只会围着起点抖。ref 是这类"回调读最新值"的最小办法。
   */
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio
  const commitRef = useRef(opts.onCommit)
  commitRef.current = opts.onCommit

  useEffect(() => {
    // 外部改初值时跟上，但拖拽中途不抢手
    if (!dragging) setRatio(clampSplit(opts.initial))
    // 只在初值变化时同步：dragging 与 orientation 不进依赖，省得每次 pointermove 都跑一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.initial])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const handle = e.currentTarget
      const track = handle.parentElement
      if (!track) return
      const orientation = opts.orientation
      handle.setPointerCapture?.(e.pointerId)
      setDragging(true)

      const rect = track.getBoundingClientRect()
      const own = handle.getBoundingClientRect()
      /*
       * 比例的定义是"工作台 : (工作台 + 结果)"，分隔条自己那几像素不属于任何一边。
       * 不减掉的话松手后 CSS 算出的宽度比指针位置差一个把手宽，看着就是没跟手。
       */
      const trackPx = (orientation === 'columns' ? rect.width : rect.height) - (orientation === 'columns' ? own.width : own.height)
      const origin = orientation === 'columns' ? rect.left : rect.top

      const move = (ev: PointerEvent) => {
        const at = orientation === 'columns' ? ev.clientX : ev.clientY
        setRatio(splitFromPointer(at - origin, trackPx, ratioRef.current))
      }
      const up = () => {
        handle.releasePointerCapture?.(e.pointerId)
        setDragging(false)
        commitRef.current(ratioRef.current)
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    },
    [opts.orientation]
  )

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    let next: number | null = null
    // 右 / 下 = 工作台变大，两个方向同一套符号，所以 orientation 不需要传进来换算
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = stepSplit(ratioRef.current, 1)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = stepSplit(ratioRef.current, -1)
    else if (e.key === 'Home') next = edgeSplit('min')
    else if (e.key === 'End') next = edgeSplit('max')
    else return
    e.preventDefault()
    setRatio(next)
    commitRef.current(next)
  }, [])

  /** 双击复位：拖歪了不用去设置里找，这是分栏条的通用预期。 */
  const onDoubleClick = useCallback(() => {
    const back = clampSplit(Number.NaN)
    setRatio(back)
    commitRef.current(back)
  }, [])

  return { ratio, dragging, onPointerDown, onKeyDown, onDoubleClick }
}

/**
 * 断点由 CSS 说了算，JS 只需要知道"现在宽不宽到能左右分"。
 * 用 matchMedia 而不是自己听 resize：省掉一个 ResizeObserver 和一次整页重排。
 * 拿不到 matchMedia（node 测试、极老浏览器）就当宽屏——最坏结果是拖不动，不是布局塌。
 */
export function useSplitOrientation(breakpointPx: number): SplitOrientation {
  const query = `(min-width: ${breakpointPx + 1}px)`
  const [wide, setWide] = useState<boolean>(() => globalThis.matchMedia?.(query).matches ?? true)
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query)
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches)
    setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  // 只关心"过没过断点"这一个事实，交给 lib 里那个纯函数表达，测试测它
  return orientationFor(wide ? breakpointPx + 1 : breakpointPx, breakpointPx)
}
