/**
 * 弹层叠放次序。
 *
 * 抽屉里点「分享」会再开一层弹窗。两层各监听一遍 Escape，按一次 Esc 就把
 * 分享弹窗连同外面的抽屉一起关掉 —— 而用户想关的只有最上面那层。
 * 同理，背景该不该锁住看的是"还开着几层"，不是"有没有弹层"：
 * 里层关掉时只该退一层，把外层还需要的锁解掉等于让鼠标能点到抽屉背后去。
 *
 * 这里只记顺序、不碰 DOM，所以能脱离 jsdom 直接测。
 */
let stack: symbol[] = []

/** 一枚令牌只能占最上面一层：重复 enter 先把旧位置剔掉，免得自己叠自己。 */
export function enterLayer(token: symbol): void {
  stack = [...stack.filter((t) => t !== token), token]
}

export function leaveLayer(token: symbol): void {
  stack = stack.filter((t) => t !== token)
}

/** 是不是当前最上面那层。只有它是，才该收到这一下 Escape。 */
export function isTopLayer(token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token
}

/** 还开着几层。0 表示背景该能点。 */
export function layerCount(): number {
  return stack.length
}
