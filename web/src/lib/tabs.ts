/**
 * 编辑器里那排 tab 的键盘切换逻辑。
 *
 * 单独拎出来是因为"方向键在 tab 之间循环"这件事，写在组件里就没法在 node 环境验证
 * （本项目刻意不引 jsdom，见 vitest.config.ts），而循环边界恰恰是最容易按到 undefined
 * 让键盘"卡住"的地方。
 */

/**
 * 从 current 往前走 delta 步（负数往后），**首尾循环**。
 *
 * current 不在列表里时不抛错：往前落到第一个、往后落到最后一个，
 * 键盘不该因为状态里残留一个旧 tab 名就按不动。
 */
export function shiftTab<T extends string>(tabs: readonly T[], current: T, delta: number): T {
  if (tabs.length === 0) return current
  const at = tabs.indexOf(current)
  if (at === -1) return (delta > 0 ? tabs[0] : tabs[tabs.length - 1]) ?? current
  // ((x % n) + n) % n：JS 的 % 跟着被除数变负，不补这一层，在最左边按左键就得到负下标
  const next = (((at + delta) % tabs.length) + tabs.length) % tabs.length
  return tabs[next] ?? current
}
