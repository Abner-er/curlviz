import { useCallback, useState } from 'react'
import { cloneSpec, type CurlSpec, type ParseWarning } from '@curlviz/core'
import { NO_OPEN_REF, type OpenRef } from '../lib/collections'
import type { SendReport } from '../types'

/**
 * 工作台 = 编辑器里这一条请求的全部状态：内容、解析告警、它与集合库的关系、上一次的结果。
 *
 * 这四个状态必须一起动，所以要有一个统一的入口：
 * 原来"换一条请求"这件事散成 6 处 `setSpec(...)`，其中 4 处各自补了一句
 * `setActiveRef(NO_OPEN_REF)`。漏一处的后果很实在 —— 从历史里取回一条别的命令，
 * activeRef 还指着集合里那条，用户点"更新原条目"就把完全无关的请求覆盖了。
 * 绑定的解除是"换请求"这件事的固有含义，不该靠每个调用点记得写。
 */

export interface LoadInput {
  /** 要显示的内容。内部一律 cloneSpec，调用方不必再惦记"这个对象是不是共享的"。 */
  spec: CurlSpec
  /** 省略 = 清空告警（换了一条命令，上一轮的告警不再相关）。 */
  warnings?: ParseWarning[]
  /** 省略 = 这条命令与集合库无关。只有"从集合打开"才显式传 ref。 */
  ref?: OpenRef
  /** 换请求默认就撤掉上一次的结果；只有需要保留结果时才显式传 false。 */
  clearReport?: boolean
}

export interface Workbench {
  spec: CurlSpec
  warnings: ParseWarning[]
  activeRef: OpenRef
  report: SendReport | null
  setReport: (r: SendReport | null) => void
  load: (input: LoadInput) => void
  patch: (p: Partial<CurlSpec>) => void
  /** 存进集合之后，编辑器要和那条新条目重新绑定。 */
  bind: (ref: OpenRef) => void
}

export function useWorkbench(initialSpec: CurlSpec, initialRef: OpenRef): Workbench {
  const [spec, setSpec] = useState<CurlSpec>(initialSpec)
  const [warnings, setWarnings] = useState<ParseWarning[]>([])
  const [activeRef, setActiveRef] = useState<OpenRef>(initialRef)
  const [report, setReport] = useState<SendReport | null>(null)

  const load = useCallback((input: LoadInput) => {
    setSpec(cloneSpec(input.spec))
    setWarnings(input.warnings ?? [])
    setActiveRef(input.ref ?? NO_OPEN_REF)
    if (input.clearReport !== false) setReport(null)
  }, [])

  /** 用户手敲：只改内容，不动警告 / 绑定 / 结果。 */
  const patch = useCallback((p: Partial<CurlSpec>) => {
    setSpec((old) => ({ ...old, ...p }))
  }, [])

  const bind = useCallback((ref: OpenRef) => setActiveRef(ref), [])

  return { spec, warnings, activeRef, report, setReport, load, patch, bind }
}
