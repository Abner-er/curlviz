import { useMemo } from 'react'
import type { CurlSpec } from '@curlviz/core'
import { requestCount, type CollectionState, type OpenRef } from '../lib/collections'
import { varsFor, type EnvState } from '../lib/environments'
import type { ShareTarget } from './CollectionsPanel'
import { CollectionsPanel } from './CollectionsPanel'
import { IoPanel } from './IoPanel'
import { VarsPanel } from './VarsPanel'

/** 抽屉里三节的 id，跳转按钮与 App 那条"先开窗再滚"的 effect 共用这一份名字。 */
export type LibrarySection = 'lib-collections' | 'lib-env' | 'lib-io'

interface Props {
  colState: CollectionState
  envState: EnvState
  activeRef: OpenRef
  currentSpec: CurlSpec
  /** 「编辑自某集合的某条」这句提示要给导入导出用，它决定导出文件里那条叫什么。 */
  currentName: string
  defaultRedact: boolean
  onClose: () => void
  onJump: (section: LibrarySection) => void
  onColState: (next: CollectionState) => void
  onEnvState: (next: EnvState) => void
  onOpen: (spec: CurlSpec, ref: OpenRef) => void
  onSaved: (ref: OpenRef) => void
  onShare: (target: ShareTarget) => void
  onApplySpec: (spec: CurlSpec) => void
  onImportCurl: (text: string) => string | null
  onNotice: (message: string) => void
}

/**
 * 资料库：集合 / 环境·变量 / 导入·导出 三节。
 *
 * 它是抽屉的内容，不是抽屉本身 —— 弹层那一套（portal、Escape、焦点进出、背景 inert）
 * 归 Overlay 与 hooks/useModalShell，这里只管把三节摊开。
 * 分成两个组件还有一层实际用处：抽屉壳要 portal 到 body，服务端渲染器不认 portal，
 * 混在一个组件里就没法用 renderToString 验这三节的内容（见 LibraryPanel.test.tsx）。
 */
export function LibraryPanel({
  colState,
  envState,
  activeRef,
  currentSpec,
  currentName,
  defaultRedact,
  onClose,
  onJump,
  onColState,
  onEnvState,
  onOpen,
  onSaved,
  onShare,
  onApplySpec,
  onImportCurl,
  onNotice
}: Props) {
  const vars = useMemo(() => varsFor(envState), [envState])

  return (
    <>
      <div className="drawer-bar">
        <div className="drawer-title">
          <h2>资料库</h2>
          {/* 抽屉默认关着，这行字加上顶栏那颗徽章，是"库里有没有东西"唯一的两个可见线索 */}
          <span className="muted">
            {colState.collections.length} 集合 · {requestCount(colState)} 请求
          </span>
          <span className="grow" />
          <button className="mini" onClick={onClose}>
            收起
          </button>
        </div>
        {/* 三节各自挂 id，靠这里跳：抽屉整高自己滚，滚到「导入 / 导出」比 Tab 二三十下快 */}
        <nav className="drawer-jump" aria-label="跳到资料库的某一节">
          <button className="mini" onClick={() => onJump('lib-collections')}>
            集合
          </button>
          <button className="mini" onClick={() => onJump('lib-env')}>
            环境 · 变量
          </button>
          <button className="mini" onClick={() => onJump('lib-io')}>
            导入 / 导出
          </button>
        </nav>
      </div>

      <div className="drawer-body">
        <div id="lib-collections" className="lib-sec">
          <CollectionsPanel
            state={colState}
            environments={envState.environments}
            currentSpec={currentSpec}
            activeRef={activeRef}
            defaultRedact={defaultRedact}
            onStateChange={onColState}
            onOpen={onOpen}
            onSaved={onSaved}
            onShare={onShare}
            onNotice={onNotice}
          />
        </div>

        <section className="card lib-sec" id="lib-env">
          <h2>
            环境 · 变量
            {envState.activeName !== null && <span className="tag-mini">{Object.keys(vars).length}</span>}
          </h2>
          {/* 全页面改环境的入口只有这一处，顶栏那颗是只读跳转 */}
          <VarsPanel spec={currentSpec} state={envState} onChange={onEnvState} />
        </section>

        <div id="lib-io" className="lib-sec">
          <IoPanel
            colState={colState}
            envState={envState}
            currentSpec={currentSpec}
            currentName={currentName}
            defaultRedact={defaultRedact}
            onColState={onColState}
            onEnvState={onEnvState}
            onApplySpec={onApplySpec}
            onImportCurl={onImportCurl}
            onNotice={onNotice}
          />
        </div>
      </div>
    </>
  )
}
