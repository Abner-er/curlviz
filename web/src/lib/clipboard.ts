/**
 * 复制到剪贴板。navigator.clipboard 要求安全上下文（https 或 localhost），
 * 本地 file:// 打开或 http 内网访问时拿不到，这时退回 textarea + execCommand。
 * 两条路都不成也绝不静默：返回 false，让界面说"没复制上，手选吧"。
 */
export async function copyText(text: string): Promise<boolean> {
  const nav = globalThis.navigator
  if (nav?.clipboard) {
    try {
      await nav.clipboard.writeText(text)
      return true
    } catch {
      /* 继续走兜底 */
    }
  }
  const doc = globalThis.document
  if (!doc) return false
  const ta = doc.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  doc.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = doc.execCommand('copy')
  } catch {
    ok = false
  }
  doc.body.removeChild(ta)
  return ok
}
