/**
 * 分栏比例：把"拖一下分隔条"这件需要真指针的事拆成可单测的算术。
 *
 * 为什么要有这一层：拖拽本身（pointer 事件、setPointerCapture）在 node 环境的测试里跑不了，
 * 但"拖完是多少、键盘按一下就变多少、坏值不能把界面拖塌"这三件事全是纯算术，
 * 而界面塌掉恰恰是这几个边界值造成的。放这儿测掉，hook 里就只剩接线。
 */

export type SplitOrientation = 'columns' | 'rows'

/** 工作台：结果 = 0.28 : 0.72 到 0.78 : 0.22 之间。再极端就有一栏没法用了。 */
export const SPLIT_MIN = 0.28
export const SPLIT_MAX = 0.78
export const SPLIT_DEFAULT = 0.56

/** 键盘一次挪多少：0.05 在 1200px 的容器上约 60px，够细又不至于按半天没反应。 */
export const SPLIT_STEP = 0.05

/**
 * 收敛到合法区间。非有限数（NaN / Infinity，来自除零或存坏的 localStorage）回落到默认值，
 * 而不是 Math.min/max 一路传下去——那两个遇到 NaN 都返回 NaN，比例变 NaN 整个 grid 就塌了。
 */
export function clampSplit(raw: number): number {
  if (!Number.isFinite(raw)) return SPLIT_DEFAULT
  if (raw < SPLIT_MIN) return SPLIT_MIN
  if (raw > SPLIT_MAX) return SPLIT_MAX
  return raw
}

/** 指针位置 → 比例。trackPx 为 0（元素还没量到）时保持当前值，不去除。 */
export function splitFromPointer(pointerPx: number, trackPx: number, current: number): number {
  if (!Number.isFinite(pointerPx) || !Number.isFinite(trackPx) || trackPx <= 0) return clampSplit(current)
  return clampSplit(pointerPx / trackPx)
}

/**
 * 键盘步进。dir 是"视觉方向"：+1 = 往右 / 往下（工作台变大），-1 = 往左 / 往上。
 * 两个方向共用一套，因为竖排时"往下"才对应工作台变大——调用点按 orientation 换算符号。
 */
export function stepSplit(current: number, dir: -1 | 0 | 1): number {
  if (dir === 0) return clampSplit(current)
  return clampSplit(clampSplit(current) + dir * SPLIT_STEP)
}

/** Home / End 的语义：把另一栏让到最大 / 把自己的栏让到最小（跟 aria-orientation 的滑动条一致）。 */
export function edgeSplit(which: 'min' | 'max'): number {
  return which === 'min' ? SPLIT_MIN : SPLIT_MAX
}

/** 给 aria-valuetext 用：读屏念"0.56"没意义，念百分比才有。 */
export function splitPercent(ratio: number): number {
  return Math.round(clampSplit(ratio) * 100)
}

/**
 * 分隔条该响应哪个方向。断点写在 CSS 里，JS 只按容器实际宽度判断，
 * 两边共用同一个数字（1100），改断点时这里必须一起改——所以由调用点传进来，不写死。
 */
export function orientationFor(width: number, breakpointPx: number): SplitOrientation {
  return width > breakpointPx ? 'columns' : 'rows'
}
