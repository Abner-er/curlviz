/**
 * 文件下载与选择。
 * 单独一个模块是因为这两件事在浏览器里都有一堆坑（blob URL 泄漏、file:// 下不可用、
 * 中文名要编码），界面里不该重复写。
 */

const JSON_MIME = 'application/json'

export function downloadBytes(filename: string, bytes: Uint8Array, mime = JSON_MIME): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // 不撤销的话每次导出都会漏一个 blob 在内存里，直到页面关闭
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
}

export function downloadText(filename: string, text: string, mime = JSON_MIME): void {
  downloadBytes(filename, new TextEncoder().encode(text), mime)
}

/** 文件名里别放 / : * ? " < > |，Windows 直接拒绝创建。 */
export function safeFileName(parts: string[], ext: string): string {
  const cleaned = parts
    .filter((p) => p.trim() !== '')
    .map((p) => p.trim().replace(/[\\/:*?"<>|]/g, '_'))
    .join('_')
    .slice(0, 80)
  return `${cleaned || 'curlviz'}${ext}`
}

export interface PickedFile {
  name: string
  text: string
}

/** 弹文件选择框；用户取消返回 null。用一次性 <input>，不要求界面挂着隐藏元素。 */
export function pickTextFile(accept = '.json,application/json'): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let settled = false
    const finish = (value: PickedFile | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    // 现代浏览器有 cancel 事件；老一点的就靠 focus 兜，总之不能永远挂着这个 promise
    input.addEventListener('cancel', () => finish(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) {
        finish(null)
        return
      }
      file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch(() => finish(null))
    })
    document.body.appendChild(input)
    input.click()
  })
}

/** 拖拽进来的文件也只认文本，超长的直接拒绝，别把 200MB 的日志读进内存。 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024

export async function readDroppedFile(file: File): Promise<PickedFile | null> {
  if (file.size > MAX_IMPORT_BYTES) return null
  try {
    return { name: file.name, text: await file.text() }
  } catch {
    return null
  }
}
