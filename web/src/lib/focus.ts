/**
 * 弹窗里的焦点管理。
 *
 * 只把"焦点该落到第几个"这段算术拎出来 —— 它在 node 里测得了；剩下的
 * querySelector / focus() 是浏览器 DOM 的活，本项目刻意不引 jsdom（见 vitest.config.ts），
 * 所以那部分写得尽量薄，薄到肉眼能核对。
 */

/**
 * 在长度为 count 的焦点序列里从 current 走 delta 步，**首尾循环**。
 *
 * - count 为 0（弹窗里一个可聚焦元素都没有）返回 -1，调用方据此什么都不做，
 *   而不是把 -1 当成一个合法下标去 focus
 * - current 越界不抛错，直接给落点：往前走是第一个、往后走是最后一个。
 *   越界是常态而不是异常 —— 焦点本来就停在弹窗容器自己身上（tabIndex=-1，不在这个列表里），
 *   这时按第一次 Tab 就该进第一项；要是先落到第一项再多走一步，第一格就被吃掉了，
 *   而 Tab 键卡住/跳一格比界面少一个按钮更难解释
 */
export function cycleIndex(count: number, current: number, delta: number): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1
  // 与 shiftTab 同一招：JS 的 % 跟着被除数变负，不补一层，在最前面按 Shift+Tab 就得到负下标
  return (((current + delta) % count) + count) % count
}

/**
 * 能被 Tab 走到的元素。
 *
 * 不含 tabindex>0 的排序：弹窗内部本来就是文档顺序，正数 tabindex 是页面级坏习惯，
 * 这里出现的每个元素都该按 DOM 顺序走。
 */
export const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
