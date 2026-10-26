import { CurlParseError, parseCurl, suggestName, type CurlSpec, type ParseWarning } from '@curlviz/core'

/**
 * "把一段文本变成可编辑的请求"这件事的入口。
 *
 * 原来这段判断散在两处：粘贴框（ImportPanel）与文件拖放（IoPanel）各自决定
 * 解析失败怎么说法、要不要补名字。两处一旦说法不一致，用户就分不清
 * "是我粘的东西不对"还是"这个工具认不了这种写法"。
 */

export type ImportResult =
  | { ok: true; spec: CurlSpec; warnings: ParseWarning[] }
  | { ok: false; error: string }

/** 解析错误说给人看的一句话；core 的 CurlParseError 带位置信息，其它异常原样带出。 */
export function importErrorText(e: unknown): string {
  return e instanceof CurlParseError ? `解析失败：${e.message}` : `解析失败：${String(e)}`
}

/**
 * 解析 curl 文本，并把"没有真名"的请求补上一个从 URL 推出来的名字。
 *
 * 补名这条规则放在这里而不是组件里：粘进来的命令十有八九不带名字，
 * 全靠用户在名称框里手打一遍，多数人就不打了，集合库里于是堆一片"未命名请求"。
 *
 * `未命名请求` 是 createDefaultSpec 的占位值，等同于没名字。
 * 说实话：解析器目前不会从命令里带出名字（curl 的 `--comment` 没实现），
 * 所以"已有真名就保留"那条分支今天是走不到的，留着是为了将来支持带名导入时
 * 不必回头改这里的判断 —— 别把它当成现行行为去测。
 */
export function importCurlText(text: string): ImportResult {
  let parsed: { spec: CurlSpec; warnings: ParseWarning[] }
  try {
    parsed = parseCurl(text)
  } catch (e) {
    return { ok: false, error: importErrorText(e) }
  }
  const name = parsed.spec.name.trim()
  const named = name === '' || name === '未命名请求' ? { ...parsed.spec, name: suggestName(parsed.spec) } : parsed.spec
  return { ok: true, spec: named, warnings: parsed.warnings }
}
