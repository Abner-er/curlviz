import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalShell, type InitialFocus } from '../hooks/useModalShell'

interface Props {
  /** 弹窗除了 Esc 没有别的标题可读，这个必给（读屏念的就是它） */
  label: string
  onClose: () => void
  /** modal = 居中；drawer = 从右边贴边拉出、整高、自身滚动 */
  variant?: 'modal' | 'drawer'
  /** 打开时焦点落容器（默认）还是落第一个控件。见 InitialFocus */
  initialFocus?: InitialFocus
  children: ReactNode
}

/**
 * 弹层外壳：portal 到 body + 焦点进出 + Tab 圈定 + Escape。
 *
 * 为什么要 portal：要 inert 的是 #root（整个应用），弹层自己不能也在里面。
 * backdrop 本来就是 position:fixed 铺满视口，换个宿主看不出视觉差别。
 */
export function Overlay({ label, onClose, variant = 'modal', initialFocus = 'container', children }: Props) {
  const shell = useModalShell(onClose, initialFocus)
  return createPortal(
    <div className={variant === 'drawer' ? 'backdrop backdrop-drawer' : 'backdrop'} onClick={onClose}>
      <div
        className={variant}
        ref={shell.ref}
        // 容器能被 focus() 拿走却不进 Tab 顺序：焦点落这儿时读屏当场念出标题，
        // 而不是等用户按下第一下 Tab 才知道弹层开了
        tabIndex={-1}
        onKeyDown={shell.onKeyDown}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
