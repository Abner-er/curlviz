import type { QuoteStyle } from '@curlviz/core'

/**
 * 「发送 ▾」那颗分裂按钮里该有什么。
 *
 * 为什么单独一层：菜单项是"这个命令在这个终端里能不能直接粘"的判断，
 * 判断错了就是用户粘一份跑不通的命令出去。判断写在纯函数里才测得到，
 * 组件只负责把它画出来（和 fetch-rules / display 同一套分工）。
 */

export type SendActionId = 'copy-terminal' | 'copy-alt-quote' | 'copy-single-line' | 'copy-url'

export interface SendMenuItem {
  id: SendActionId
  label: string
  /** 菜单项右边那句小字：说清粘到哪儿能用。 */
  hint: string
}

export interface SendMenu {
  /** 顶部说明行（不是按钮）。没有就是 null。 */
  note: string | null
  items: SendMenuItem[]
}

const QUOTE_LABEL: Record<QuoteStyle, string> = { posix: 'POSIX 单引号', windows: 'Windows 双引号' }

const ALT: Record<QuoteStyle, QuoteStyle> = { posix: 'windows', windows: 'posix' }

/** 另一种引号风格该贴到哪儿：这条映射是这菜单存在的理由，别让用户自己猜。 */
const TARGET: Record<QuoteStyle, string> = {
  posix: 'bash / Git-Bash / WSL / macOS 终端',
  windows: 'cmd.exe（不用 \\ 换行，双引号）'
}

export function buildSendMenu(input: { quoteStyle: QuoteStyle; multiline: boolean; corsBlocked: boolean }): SendMenu {
  const items: SendMenuItem[] = [
    {
      id: 'copy-terminal',
      label: `复制到终端（${QUOTE_LABEL[input.quoteStyle]}）`,
      hint: TARGET[input.quoteStyle]
    }
  ]

  // 另一种引号风格常驻：当前风格只有一份时，切过去这件事就没人能一眼看到
  items.push({
    id: 'copy-alt-quote',
    label: `复制为${QUOTE_LABEL[ALT[input.quoteStyle]]}`,
    hint: TARGET[ALT[input.quoteStyle]]
  })

  // 已经是单行了就别给"复制为单行"，点了没反应是最容易被当成 bug 的那种多余
  if (input.multiline) {
    items.push({ id: 'copy-single-line', label: '复制为单行命令', hint: '没有 \\ 续行，适合一行历史 / 写进脚本' })
  }

  items.push({ id: 'copy-url', label: '只复制 URL', hint: '只要地址，不带参数以外的任何东西' })

  return {
    note: input.corsBlocked
      ? '浏览器直发要先过 OPTIONS 预检。很多网关没实现预检，这条路走不通不是命令写错了。'
      : null,
    items
  }
}

/**
 * 发送按钮上那颗徽标的文案。措辞是"可能被拦"而不是"一定被拦"：
 * 预检要不要发能算出来（fetch-rules），对方答不答应算不出来，这里不能越界。
 */
export function sendBadge(preflightExpected: boolean): string {
  return preflightExpected ? '可能被预检拦' : ''
}
