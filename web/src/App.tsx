import { useCallback, useEffect, useMemo, useState } from 'react'
import { KNOWN_METHODS, createDefaultSpec, generateCurl, type CurlSpec } from '@curlviz/core'
import type { Settings } from './types'
import { KEYS, createBrowserStore } from './lib/storage'
import { varsFor, type EnvState } from './lib/environments'
import { boundEntryOf, requestCount, type CollectionState, type OpenRef } from './lib/collections'
import { applySharePayload, loadBootState } from './lib/bootstrap'
import { entryForEditor } from './lib/history'
import { importCurlText } from './lib/imports'
import { shiftTab } from './lib/tabs'
import { prefersReducedMotion, scrollBehaviorFor } from './lib/display'
import { usePersistence } from './hooks/usePersistence'
import { useWorkbench } from './hooks/useWorkbench'
import { useSend } from './hooks/useSend'
import { useShareImport } from './hooks/useShareImport'
import { CurlPreview } from './components/CurlPreview'
import { ImportDialog } from './components/ImportDialog'
import { Overlay } from './components/Overlay'
import { ResponsePanel } from './components/ResponsePanel'
import { HistoryPanel } from './components/HistoryPanel'
import { KeyValueTable } from './components/KeyValueTable'
import { AuthEditor, BodyEditor, OptionsEditor } from './components/Editors'
import { LibraryPanel, type LibrarySection } from './components/LibraryPanel'
import type { ShareTarget } from './components/CollectionsPanel'
import { ShareDialog } from './components/ShareDialog'

type Tab = 'query' | 'headers' | 'body' | 'auth' | 'options'

const DEFAULT_SETTINGS: Settings = { quoteStyle: 'posix', multiline: true, redactHistory: true }

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

  // 这次生效的变量表：激活环境优先，其它环境兜底（语义来自 core 的 toVarMap）
  const vars = useMemo(() => varsFor(envState), [envState])

  const sender = useSend({
    spec: wb.spec,
    vars,
    settings,
    setReport: wb.setReport,
    persistence,
    initialHistory
  })

  const curl = useMemo(
    () => generateCurl(wb.spec, { quoteStyle: settings.quoteStyle, multiline: settings.multiline }),
    [wb.spec, settings.quoteStyle, settings.multiline]
  )

  const [tab, setTab] = useState<Tab>('query')
  const [importOpen, setImportOpen] = useState(false)
  /**
   * 资料库抽屉，默认关着 —— 这个工具的主动作是"改命令、发出去、看结果"，
   * 那一整页都该留给工作台。
   * 代价写明白：库收起来之后，第一次用的人看不出这里有个集合库。
   * 补法是顶栏那颗按钮带集合数 / 请求数的徽章，不开也能知道库里有没有东西。
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
   * 顶栏徽章：抽屉默认关着，"库里到底有没有东西"就只剩这一处能看出来。
   * 只给集合数与请求总数，不给"是哪个集合"—— 这颗按钮的职责是提示有库、
   * 以及库有多大，具体翻哪一节是抽屉里的事。
   * 请求数走 lib 的 requestCount，与抽屉标题那一行同一个算法。
   */
  const libBadge = useMemo(
    () => ({ collections: colState.collections.length, requests: requestCount(colState) }),
    [colState]
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
        />
      )
    }
    if (which === 'headers') {
      return (
        <KeyValueTable
          rows={wb.spec.headers}
          onChange={(rows) => wb.patch({ headers: rows })}
          keyPlaceholder="Header-Name"
          valuePlaceholder="值（留空输出 K: 表示发空头）"
          pairLabel="头 / 值"
        />
      )
    }
    if (which === 'body') return <BodyEditor spec={wb.spec} onChange={wb.patch} />
    if (which === 'auth') return <AuthEditor auth={wb.spec.auth} onChange={(a) => wb.patch({ auth: a })} />
    return (
      <OptionsEditor
        options={wb.spec.options}
        rawArgs={wb.spec.rawArgs}
        onChange={(o) => wb.patch({ options: o })}
        onDropRawArg={(i) => wb.patch({ rawArgs: wb.spec.rawArgs.filter((_, k) => k !== i) })}
      />
    )
  }

  return (
    <>
      <header className="top">
        <h1>CurlViz</h1>
        <span className="tag">curl 可视化 · 免登录 / 不过云 / 数据全本地</span>
        <div className="grow" />
        <label style={{ margin: 0 }}>
          引号
          <select
            value={settings.quoteStyle}
            onChange={(e) => setSettings({ ...settings, quoteStyle: e.target.value as Settings['quoteStyle'] })}
            style={{ marginLeft: '0.35rem' }}
          >
            <option value="posix">POSIX（bash / Git-Bash / macOS）</option>
            <option value="windows">Windows（cmd.exe）</option>
          </select>
        </label>
        <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', margin: 0 }}>
          <input
            type="checkbox"
            checked={settings.multiline}
            onChange={(e) => setSettings({ ...settings, multiline: e.target.checked })}
          />
          多行
        </label>
        <label style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', margin: 0 }}>
          <input
            type="checkbox"
            checked={settings.redactHistory}
            onChange={(e) => setSettings({ ...settings, redactHistory: e.target.checked })}
          />
          历史脱敏
        </label>

        {/*
          环境在顶栏只留"现在生效的是哪个"这一句读数，不留下拉框。
          原来这里有一个选择器、左栏还有一个，两个地方改同一个状态，
          人会不确定"现在生效的到底是哪个"；现在改动仍然只有抽屉里那一处入口。
          这颗是只读的跳转按钮，读屏念出来也是"状态 + 去看"，不是"在这儿换环境"。
        */}
        <button
          className="env-chip"
          onClick={() => openLibrary('lib-env')}
          title={envState.activeName === null ? '没启用环境，点开看变量与环境怎么配' : `当前环境：${envState.activeName}`}
        >
          环境 · {envState.activeName ?? '未启用'}
          {envState.activeName !== null && <span className="tag-mini">{Object.keys(vars).length}</span>}
        </button>

        <button
          className="mini"
          onClick={() => openLibrary()}
          aria-haspopup="dialog"
          title="集合 / 环境 / 导入导出（抽屉，数据都在这台机器上）"
        >
          资料库
          <span className="tag-mini">
            {libBadge.collections} 集合 · {libBadge.requests} 请求
          </span>
        </button>
      </header>

      <main>
        <div className="shell-work">
          {persistence.storageIssue && (
            <ul className="notes" style={{ marginBottom: '0.8rem' }}>
              <li className="err">{persistence.storageIssue}</li>
            </ul>
          )}

          <section className="card">
            <h2>请求</h2>
            <div className="row">
              <div style={{ width: '12rem' }}>
                <label>名称</label>
                <input value={wb.spec.name} onChange={(e) => wb.patch({ name: e.target.value })} />
              </div>
              {boundEntry && (
                <span className="muted" style={{ paddingBottom: '0.4rem' }}>
                  编辑自「{boundEntry.collection}」的 {boundEntry.request}
                </span>
              )}
            </div>
            <div className="url-bar" style={{ marginTop: '0.5rem' }}>
              <select
                value={
                  KNOWN_METHODS.includes(wb.spec.method as (typeof KNOWN_METHODS)[number]) ? wb.spec.method : 'CUSTOM'
                }
                onChange={(e) => {
                  if (e.target.value !== 'CUSTOM') wb.patch({ method: e.target.value })
                }}
                aria-label="方法"
                style={{ width: '7.5rem' }}
              >
                {KNOWN_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="CUSTOM">自定义…</option>
              </select>
              <input
                className="url"
                value={wb.spec.method}
                onChange={(e) => wb.patch({ method: e.target.value.toUpperCase() })}
                aria-label="方法名"
                title="curl 不限制方法名，可以直接改"
              />
              <input
                className="url grow"
                value={wb.spec.url}
                placeholder="https://internal.api/v1/list"
                spellCheck={false}
                onChange={(e) => wb.patch({ url: e.target.value })}
                aria-label="URL"
              />
              {sender.sending ? (
                <button onClick={sender.cancel}>取消</button>
              ) : (
                <button className="primary" onClick={() => void sender.send()} disabled={!sender.canSend}>
                  发送
                </button>
              )}
            </div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              {/* 弹窗而不是一整块内联面板：粘贴导入是偶尔为之的动作，
                  没道理让它长期占走工作区最贵的那几行高度 */}
              <button className="mini" onClick={() => setImportOpen(true)} aria-haspopup="dialog">
                粘贴 curl 导入
              </button>
              <button className="mini" onClick={newRequest}>
                新建空请求
              </button>
              <button
                className="mini"
                onClick={() => setShare({ kind: 'request', spec: wb.spec, label: wb.spec.name || '当前请求' })}
                disabled={!sender.canSend}
                title="生成链接 / 二维码，对方打开就导入（默认脱敏，本地生成）"
              >
                分享这条
              </button>
              <span className="muted">Ctrl+Enter 发送</span>
            </div>
            {!sender.canSend && <p className="muted">填了 URL 才能发送。</p>}
          </section>

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
              原来它在右栏，视线要跨过整个响应区才能对上 */}
          <CurlPreview
            curl={curl}
            warnings={wb.warnings}
            quoteStyle={settings.quoteStyle}
            onFixQuoteStyle={() => setSettings({ ...settings, quoteStyle: 'windows' })}
          />
        </div>

        <div className="shell-result">
          <ResponsePanel report={wb.report} sending={sender.sending} />
          <HistoryPanel
            items={sender.history}
            quoteStyle={settings.quoteStyle}
            multiline={settings.multiline}
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
      </main>

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
    </>
  )
}

export default App
