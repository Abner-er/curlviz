import { SPLIT_MAX, SPLIT_MIN, splitPercent, type SplitOrientation } from '../lib/split'
import type { SplitHandle } from '../hooks/useSplit'

interface Props {
  orientation: SplitOrientation
  ratio: number
  /** 读屏用的一句，例如"工作台与结果之间的分隔条"。 */
  label: string
  handle: SplitHandle
}

/**
 * 两栏之间的分隔条。
 *
 * 为什么不是纯 CSS：resize 手柄能拖是视觉约定，但只用鼠标的话键盘用户就永远调不了栏宽，
 * 所以这里带 role="separator" + aria-value*，方向键 / Home / End 都能调（算术在 lib/split.ts）。
 * 双击复位是通用预期，实现挂在 hook 上。
 */
export function Splitter({ orientation, ratio, label, handle }: Props) {
  const pct = splitPercent(ratio)
  return (
    <div
      className={`splitter ${orientation === 'columns' ? 'splitter-col' : 'splitter-row'}${handle.dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={orientation === 'columns' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={splitPercent(SPLIT_MIN)}
      aria-valuemax={splitPercent(SPLIT_MAX)}
      aria-valuetext={`工作台 ${pct}%`}
      tabIndex={0}
      title="拖动调整两栏宽度 · 方向键也可以 · 双击复位"
      onPointerDown={handle.onPointerDown}
      onKeyDown={handle.onKeyDown}
      onDoubleClick={handle.onDoubleClick}
    >
      <span className="grip" aria-hidden="true" />
    </div>
  )
}

export default Splitter
