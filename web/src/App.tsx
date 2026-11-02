import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { createDefaultSpec, generateCurl, type CurlSpec, type QuoteStyle } from '@curlviz/core'
import type { Settings } from './types'
import { KEYS, createBrowserStore } from './lib/storage'
import { varsFor, type EnvState } from './lib/environments'
import { boundEntryOf, requestCount, type CollectionState, type OpenRef } from './lib/collections'
import { applySharePayload, loadBootState } from './lib/bootstrap'
import { entryForEditor } from './lib/history'
import { importCurlText } from './lib/imports'
import { shiftTab } from './lib/tabs'
import { SPLIT_DEFAULT } from './lib/split'
import { buildSendMenu, type SendActionId } from './lib/send-actions'
import { copyText } from './lib/clipboard'
import {
  countBadge,
  currentPageHref,
  headerRowNote,
  prefersReducedMotion,
  preSendFacts,
  queryRowNote,
  scrollBehaviorFor
} from './lib/display'
import { usePersistence } from './hooks/usePersistence'
import { useWorkbench } from './hooks/useWorkbench'
import { useSend } from './hooks/useSend'
import { useExecutors } from './hooks/useExecutors'
import { useShareImport } from './hooks/useShareImport'
import { useSplit, useSplitOrientation } from './hooks/useSplit'
import { CurlPreview } from './components/CurlPreview'
import { ImportDialog } from './components/ImportDialog'
import { Overlay } from './components/Overlay'
import { RequestBar } from './components/RequestBar'
import { TransportPicker, type TransportOption } from './components/TransportPicker'
import { ExecutorManager } from './components/ExecutorManager'
import { ResponsePanel } from './components/ResponsePanel'
import { HistoryPanel } from './components/HistoryPanel'
import { KeyValueTable } from './components/KeyValueTable'
import { Rail, type RailAction } from './components/Rail'
import { Splitter } from './components/Splitter'
import { AuthEditor, BodyEditor, OptionsEditor } from './components/Editors'
import { LibraryPanel, type LibrarySection } from './components/LibraryPanel'
import type { ShareTarget } from './components/CollectionsPanel'
import { ShareDialog } from './components/ShareDialog'

type Tab = 'query' | 'headers' | 'body' | 'auth' | 'options'

/**
 * 布局断点（px）：宽到能左右分栏就左右，否则上下。
 * 这个数字必须与 styles.css 里那条 @media 一致 —— 两边不一致的话
 * JS 以为在左右分而 CSS 排成上下，分隔条就会拖到一个对不上的方向上。
 */
const SPLIT_BREAKPOINT = 1100

const DEFAULT_SETTINGS: Settings = {
  quoteStyle: 'posix',
  multiline: true,
  redactHistory: true,
  curlOpen: true,
  splitRatio: SPLIT_DEFAULT
}

/**
 * 存储后端与开机状态在模块加载时算一次：
 * 浏览器给不了 localStorage（隐私模式 / file://）就用内存后端，功能不塌，只如实提示。
 * 读回来的东西已经在 bootstrap 里收敛过形状（坏数据、M1 旧变量迁移、openRef 悬空校验）。
 */
const session = createBrowserStore()
const boot = loadBootState(session.store)
/** 开机要读的两份数据：读一次就够，放进渲染里会变成每次按键都 JSON.parse 一遍。 */
const initialDraft = session.store.load(KEYS.draft, createDefaultSpec())
const initialHistory = session.store.load(KEYS.history, [])

/** toast 挂 5 秒：再长就变成挡在界面右下角的常驻噪音。 */
const TOAST_MS = 5000

export function App() {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...session.store.load(KEYS.settings, {}) }))
  const [envState, setEnvState] = useState<EnvState>(() => boot.envState)
  const [colState, setColState] = useState<CollectionState>(() => boot.colState)

  /** 编辑器这一条请求的内容 / 告警 / 与集合库的关系 / 上次结果，全部由工作台管。 */
  const wb = useWorkbench(initialDraft, boot.openRef)
  // 下面几处回调依赖写 load 而不是 wb：load 是稳定引用，wb 那个对象每次渲染都是新的，
  // 挂在依赖里等于每次渲染都重建回调，子组件跟着白白重渲一次。
  const { load } = wb

  const persistence = usePersistence(session, {
    draft: wb.spec,
    settings,
    environments: envState,
    collections: colState,
    openRef: wb.activeRef
  })

  // 执行机注册表 + 会话 token（token 只在内存，刷新即空）。transport 现算现给 useSend。
  const exec = useExecutors(session.store, persistence)
  const transportOptions: TransportOption[] = exec.registry.executors.map((e) => ({
    id: e.id,
    name: e.name,
    hasToken: exec.tokenOf(e.id) !== ''
  }))

  // 这次生效的变量表：激活环境优先，其它环境兜底（语义来自 core 的 toVarMap）
  const vars = useMemo(() => varsFor(envState), [envState])

  /*
   * 发送前就该看见的提醒（跨域预检是其中一条）+ 请求行那颗徽标，一次判定出两份结果。
   * 判据不在这里，在 lib/display + lib/fetch-rules：App 只负责把结果递给要画它的地方。
   * 页面地址在本地是 http://localhost:5183，目标却常常是内网另一台机器或公网 API ——
   * 那就跨域，浏览器说了算的部分得先说清楚。
   */
  const facts = useMemo(() => preSendFacts(wb.spec, vars, currentPageHref()), [wb.spec, vars])

  const sender = useSend({
    spec: wb.spec,
    vars,
    settings,
    transport: exec.transport,
    setReport: wb.setReport,
    persistence,
    initialHistory
  })

  const curl = useMemo(
    () => generateCurl(wb.spec, { quoteStyle: settings.quoteStyle, multiline: settings.multiline }),
    [wb.spec, settings.quoteStyle, settings.multiline]
  )

  const orientation = useSplitOrientation(SPLIT_BREAKPOINT)
  const commitSplit = useCallback((ratio: number) => setSettings((s) => ({ ...s, splitRatio: ratio })), [])
  const split = useSplit({ initial: settings.splitRatio, onCommit: commitSplit, orientation })

  const [tab, setTab] = useState<Tab>('query')
  const [importOpen, setImportOpen] = useState(false)
  /** 执行机管理弹窗。 */
  const [managerOpen, setManagerOpen] = useState(false)
  /**
   * 资料库抽屉，默认关着 —— 这个工具的主动作是"改命令、发出去、看结果"，
   * 那一整页都该留给工作台。
   * 代价写明白：库收起来之后，第一次用的人看不出这里有个集合库 ——
   * 补法是左侧那条操作栏：集合 / 环境 / 导出三个入口常驻，徽章上还带着库里有多少条。
   */
  const [libOpen, setLibOpen] = useState(false)
  /**
   * 抽屉是按需挂载的：「跳到环境那一节」按下时那个 id 还不存在，
   * 只能先记下要跳哪儿，等抽屉渲染完再滚（直接 getElementById 会拿到 null，按钮就成哑的）。
   */
  const [libJump, setLibJump] = useState<LibrarySection | null>(null)
  const [share, setShare] = useState<ShareTarget | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const openLibrary = useCallback((section?: LibrarySection) => {
    setLibOpen(true)
    setLibJump(section ?? null)
  }, [])

  useEffect(() => {
    if (!libOpen || libJump === null) return
    const el = document.getElementById(libJump)
    // 滚动发生在抽屉自己身上，scrollIntoView 会自己找最近的可滚动祖先，不用管是谁在滚。
    // 平滑与否得在调用点问一次：样式表那条 prefers-reduced-motion 管不住 JS 的 smooth
    if (el !== null) el.scrollIntoView({ behavior: scrollBehaviorFor(prefersReducedMotion()), block: 'start' })
    // 滚完立刻清掉：不说的话，第二次点同一节时状态没变，effect 不再跑，同一颗按钮按两下就没反应
    setLibJump(null)
  }, [libOpen, libJump])

  const notify = useCallback((message: string) => setToast(message), [])

  /**
   * toast 定时消失集中在这儿，不散进各面板：
   * 一句话挂 5 秒和挂 5 分钟是两种完全不同的打扰程度，得有一个地方说了算。
   */
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast])

  // 开机只做一次：M1 的扁平变量搬进环境后要删掉旧键，否则每次开机重复迁一遍
  useEffect(() => {
    if (boot.didMigrate) persistence.erase(KEYS.vars)
    if (boot.note) notify(boot.note)
    // 只在挂载那一次处理启动状态，后续状态变化不该再触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 地址栏带 #share= 就开机导入；这条链接只处理一次，之后不再触发。 */
  useShareImport({
    onPayload: (payload) => {
      const applied = applySharePayload(payload, colState, envState)
      if (applied.spec) load({ spec: applied.spec })
      if (applied.collectionId) setColState(applied.colState)
      setEnvState(applied.envState)
      notify(applied.note)
    },
    onError: notify
  })

  const onImport = useCallback(
    (text: string): string | null => {
      const r = importCurlText(text)
      if (!r.ok) return r.error
      load({ spec: r.spec, warnings: r.warnings })
      // 成功就返回 null，关框是弹窗自己的事：这里再 setImportOpen(false) 会变成
      // 抽屉里的「导入 / 导出」也顺带把粘贴弹窗关掉，而那条路径压根没开过它
      return null
    },
    [load]
  )

  const newRequest = useCallback(() => load({ spec: createDefaultSpec() }), [load])

  const openFromCollection = useCallback(
    (target: CurlSpec, ref: OpenRef) => {
      load({ spec: target, ref })
      // 从库里挑一条 = "取东西"这个动作结束了，接下来要的是整页改命令，
      // 抽屉不自己关的话用户会以为界面卡住（背景还锁着）
      setLibOpen(false)
      notify('已从集合取回，改完可以「更新原条目」。')
    },
    [load, notify]
  )

  const boundEntry = useMemo(() => boundEntryOf(colState, wb.activeRef), [colState, wb.activeRef])

  /**
   * 操作栏上的徽章：抽屉默认关着，"库里到底有没有东西、历史里有多少条"就只剩这几处能看出来。
   * 请求数走 lib 的 requestCount，与抽屉标题那一行同一个算法。
   */
  const railBadges = useMemo(
    () => ({
      collections: countBadge(requestCount(colState)),
      env: envState.activeName === null ? undefined : `${Object.keys(vars).length}`,
      history: countBadge(sender.history.length)
    }),
    [colState, envState.activeName, vars, sender.history.length]
  )

  const sendMenu = useMemo(
    () => buildSendMenu({ quoteStyle: settings.quoteStyle, multiline: settings.multiline, corsBlocked: facts.preflightExpected }),
    [settings.quoteStyle, settings.multiline, facts.preflightExpected]
  )

  /**
   * 「发送 ▾」里的每一项都只是"换一种形态复制这份命令"，所以全部走同一份 generateCurl，
   * 不另拼字符串 —— 拼两份就会出现两份不一致的命令，而用户只会发现坏的那份。
   */
  const onSendAction = useCallback(
    async (id: SendActionId) => {
      const other: QuoteStyle = settings.quoteStyle === 'posix' ? 'windows' : 'posix'
      let text = curl
      let label = '命令'
      if (id === 'copy-alt-quote') {
        text = generateCurl(wb.spec, { quoteStyle: other, multiline: settings.multiline })
        label = `${other === 'windows' ? 'cmd.exe' : 'POSIX'} 引号的命令`
      } else if (id === 'copy-single-line') {
        text = generateCurl(wb.spec, { quoteStyle: settings.quoteStyle, multiline: false })
        label = '单行命令'
      } else if (id === 'copy-url') {
        text = wb.spec.url
        label = 'URL'
      }
      const ok = await copyText(text)
      notify(ok ? `已复制${label}，可直接粘出去` : '浏览器不让写剪贴板，请手动全选复制')
    },
    [curl, notify, settings.multiline, settings.quoteStyle, wb.spec]
  )

  const onRail = useCallback(
    (action: RailAction) => {
      if (action === 'new') return newRequest()
      if (action === 'import') return setImportOpen(true)
      if (action === 'share')
        return setShare({ kind: 'request', spec: wb.spec, label: wb.spec.name || '当前请求' })
      if (action === 'history') {
        // 历史在结果栏底部，窄屏时可能在视口外：这颗按钮的意思是"带我去看"，不是开关
        const el = document.getElementById('history-card')
        if (el !== null) el.scrollIntoView({ behavior: scrollBehaviorFor(prefersReducedMotion()), block: 'start' })
        return
      }
      openLibrary(action === 'env' ? 'lib-env' : action === 'io' ? 'lib-io' : 'lib-collections')
    },
    [newRequest, openLibrary, wb.spec]
  )

  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: 'query', label: 'Query', badge: wb.spec.query.filter((q) => q.enabled && q.key !== '').length },
    { value: 'headers', label: 'Headers', badge: wb.spec.headers.filter((h) => h.enabled && h.key !== '').length },
    { value: 'body', label: 'Body', badge: wb.spec.body.type === 'none' ? 0 : 1 },
    { value: 'auth', label: 'Auth', badge: wb.spec.auth.type === 'none' ? 0 : 1 },
    { value: 'options', label: '选项', badge: wb.spec.rawArgs.length }
  ]

  /**
   * 某个页签对应的编辑内容。
   *
   * 从 JSX 里挪出来成函数，是因为下面要把五个面板壳一起渲染：每颗页签的 aria-controls
   * 都指着一个 id，被指着的 id 必须一直在 DOM 里存在，未选中的那个壳就空着。
   */
  const panelFor = (which: Tab) => {
    if (which === 'query') {
      return (
        <KeyValueTable
          rows={wb.spec.query}
          onChange={(rows) => wb.patch({ query: rows })}
          keyPlaceholder="参数名"
          valuePlaceholder="值"
          pairLabel="参数 / 值"
          rowNote={queryRowNote}
        />
      )
    }
    if (which === 'headers') {
      return (
        <KeyValueTable
          rows={wb.spec.headers}
          onChange={(rows) => wb.patch({ headers: rows })}
          keyPlaceholder="Header-Name"
          valuePlaceholder="值（留空 = -H 'K:'，curl 是删掉这个头）"
          pairLabel="头 / 值"
          rowNote={headerRowNote}
        />
      )
    }
    if (which === 'body') return <BodyEditor spec={wb.spec} onChange={wb.patch} />
    if (which === 'auth') return <AuthEditor auth={wb.spec.auth} onChange={(a) => wb.patch({ auth: a })} />
    return (
      <OptionsEditor
        options={wb.spec.options}
        rawArgs={wb.spec.rawArgs}
        url={wb.spec.url}
        onChange={(o) => wb.patch({ options: o })}
        onDropRawArg={(i) => wb.patch({ rawArgs: wb.spec.rawArgs.filter((_, k) => k !== i) })}
      />
    )
  }

  return (
    <div className="app">
      <header className="top">
        <h1>CurlViz</h1>
        <span className="tag">curl 可视化 · 免登录 / 不过云 / 数据全本地</span>
        <div className="grow" />
        {/*
          顶栏只剩这三样。引号与多行挪进「等价 curl」那一行（它们只改那份命令的形状，
          放在被影响的东西旁边才看得出关联），历史脱敏挪进历史卡标题行，
          集合 / 环境 / 导入 / 分享挪进左侧操作栏 —— 原来这 6 样挤在一条 56px 高的栏里，
          1280 宽就换行成 98px（实测），把最贵的首屏高度吃掉了。
        */}
        <button
          className="env-chip"
          onClick={() => openLibrary('lib-env')}
          title={envState.activeName === null ? '没启用环境，点开看变量与环境怎么配' : `当前环境：${envState.activeName}`}
        >
          环境 · {envState.activeName ?? '未启用'}
          {envState.activeName !== null && <span className="tag-mini">{Object.keys(vars).length}</span>}
        </button>
      </header>

      <div className="body">
        <Rail
          onAction={onRail}
          badges={railBadges}
          disabled={{ share: !sender.canSend }}
        />

        <div className="track" style={{ '--split': String(split.ratio) } as CSSProperties}>
          <main className="col-work">
            {persistence.storageIssue && (
              <ul className="notes" style={{ marginBottom: '0.8rem' }}>
                <li className="err">{persistence.storageIssue}</li>
              </ul>
            )}

            <RequestBar
              name={wb.spec.name}
              method={wb.spec.method}
              url={wb.spec.url}
              sending={sender.sending}
              canSend={sender.canSend}
              preflightExpected={facts.preflightExpected}
              preflightReason={facts.reason}
              menu={sendMenu}
              picker={
                <TransportPicker
                  activeId={exec.registry.activeId}
                  options={transportOptions}
                  onSelect={exec.select}
                  onManage={() => setManagerOpen(true)}
                />
              }
              boundNote={boundEntry ? `编辑自「${boundEntry.collection}」的 ${boundEntry.request}` : null}
              onName={(name) => wb.patch({ name })}
              onMethod={(method) => wb.patch({ method })}
              onUrl={(url) => wb.patch({ url })}
              onSend={() => void sender.send()}
              onCancel={sender.cancel}
              onAction={(id) => void onSendAction(id)}
            />

            <section className="card">
              <nav
                className="tabs"
                role="tablist"
                aria-label="请求编辑器分区"
                onKeyDown={(e) => {
                  const values = tabs.map((t) => t.value)
                  let next: Tab
                  if (e.key === 'ArrowRight') next = shiftTab(values, tab, 1)
                  else if (e.key === 'ArrowLeft') next = shiftTab(values, tab, -1)
                  else if (e.key === 'Home') next = values[0] ?? tab
                  else if (e.key === 'End') next = values[values.length - 1] ?? tab
                  else return
                  e.preventDefault()
                  // 页签之间用方向键走，所以只有选中那颗留在 Tab 顺序里（roving tabindex）。
                  // 换完页签必须把焦点也挪过去：焦点留在原来那颗上时它已经变成 tabIndex=-1，
                  // 再按 Tab 会从中间跳出去，读屏报的页签名也和面板对不上。
                  setTab(next)
                  document.getElementById(`tab-${next}`)?.focus()
                }}
              >
                {tabs.map((t) => (
                  <button
                    key={t.value}
                    id={`tab-${t.value}`}
                    role="tab"
                    aria-selected={tab === t.value}
                    aria-controls={`panel-${t.value}`}
                    tabIndex={tab === t.value ? 0 : -1}
                    onClick={() => setTab(t.value)}
                  >
                    {t.label}
                    {t.badge ? ` (${t.badge})` : ''}
                  </button>
                ))}
              </nav>

              {tabs.map((t) => (
                <div
                  key={t.value}
                  role="tabpanel"
                  id={`panel-${t.value}`}
                  aria-labelledby={`tab-${t.value}`}
                  hidden={tab !== t.value}
                >
                  {tab === t.value ? panelFor(t.value) : null}
                </div>
              ))}
            </section>

            {/* curl 预览紧跟编辑器：改一个参数要立刻看到命令怎么变，
                原来它在右栏，视线要跨过整个响应区才能对上。
                折成 dock 是为了让它别再把整栏撑到 427px（实测）。 */}
            <CurlPreview
              curl={curl}
              warnings={wb.warnings}
              preNotices={facts.notices}
              quoteStyle={settings.quoteStyle}
              multiline={settings.multiline}
              onQuoteStyle={(quoteStyle) => setSettings({ ...settings, quoteStyle })}
              onMultiline={(multiline) => setSettings({ ...settings, multiline })}
              open={settings.curlOpen}
              onToggle={(curlOpen) => setSettings({ ...settings, curlOpen })}
            />
          </main>

          <Splitter
            orientation={orientation}
            ratio={split.ratio}
            label="工作台与结果之间的分隔条"
            handle={split}
          />

          <aside className="col-result">
            <ResponsePanel report={wb.report} sending={sender.sending} />
            <div id="history-card">
              <HistoryPanel
                items={sender.history}
                quoteStyle={settings.quoteStyle}
                multiline={settings.multiline}
                redactHistory={settings.redactHistory}
                onRedactHistory={(redactHistory) => setSettings({ ...settings, redactHistory })}
                onPick={(e) => {
                  const picked = entryForEditor(e)
                  load({ spec: picked.spec })
                  // 脱敏过的历史条目必须当场说一句：不然用户拿 •••••••• 当真凭据发出去，
                  // 收到 401 只会怀疑接口坏了
                  if (picked.note) notify(picked.note)
                }}
                onDelete={sender.removeHistory}
                onClear={sender.clearHistory}
              />
            </div>
          </aside>
        </div>
      </div>

      {/*
        资料库抽屉：集合 / 环境 / 导入导出都在这里面，不进正常文档流，工作区因此吃满整页。
        Overlay 本身 portal 到 body，写在这儿只影响阅读顺序（先改命令，再翻库），不影响视觉。
        焦点落容器而不是第一个控件：抽屉里除了「收起」，往下全是删除 / 重命名这类按钮，
        开一次框就误按一次回车，代价比多按一次 Tab 大得多。
      */}
      {libOpen && (
        <Overlay variant="drawer" label="资料库" onClose={() => setLibOpen(false)}>
          <LibraryPanel
            colState={colState}
            envState={envState}
            activeRef={wb.activeRef}
            currentSpec={wb.spec}
            currentName={boundEntry?.request ?? wb.spec.name}
            defaultRedact={settings.redactHistory}
            onClose={() => setLibOpen(false)}
            onJump={setLibJump}
            onColState={setColState}
            onEnvState={setEnvState}
            onOpen={openFromCollection}
            onSaved={wb.bind}
            onShare={setShare}
            onApplySpec={(s) => load({ spec: s })}
            onImportCurl={onImport}
            onNotice={notify}
          />
        </Overlay>
      )}

      {importOpen && <ImportDialog onImport={onImport} onClose={() => setImportOpen(false)} />}

      {managerOpen && (
        <Overlay label="执行机" onClose={() => setManagerOpen(false)} initialFocus="field">
          <ExecutorManager
            registry={exec.registry}
            tokenOf={exec.tokenOf}
            onAdd={exec.add}
            onUpdate={exec.update}
            onRemove={exec.remove}
            onSetToken={exec.setToken}
          />
        </Overlay>
      )}

      {/* 分享永远默认脱敏：历史留在本机，而分享是要把东西送出这台机器的 */}
      {share && (
        <ShareDialog
          target={share}
          environments={envState.environments}
          defaultRedact
          onClose={() => setShare(null)}
          onNotice={notify}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default App
