import { useCallback, useEffect, useMemo, useState } from 'react'
import { KNOWN_METHODS, createDefaultSpec, generateCurl, type CurlSpec } from '@curlviz/core'
import type { Settings } from './types'
import { KEYS, createBrowserStore } from './lib/storage'
import { varsFor, type EnvState } from './lib/environments'
import { boundEntryOf, type CollectionState, type OpenRef } from './lib/collections'
import { applySharePayload, loadBootState } from './lib/bootstrap'
import { entryForEditor } from './lib/history'
import { importCurlText } from './lib/imports'
import { usePersistence } from './hooks/usePersistence'
import { useWorkbench } from './hooks/useWorkbench'
import { useSend } from './hooks/useSend'
import { useShareImport } from './hooks/useShareImport'
import { CurlPreview } from './components/CurlPreview'
import { ImportPanel } from './components/ImportPanel'
import { ResponsePanel } from './components/ResponsePanel'
import { HistoryPanel } from './components/HistoryPanel'
import { KeyValueTable } from './components/KeyValueTable'
import { AuthEditor, BodyEditor, OptionsEditor } from './components/Editors'
import { VarsPanel } from './components/VarsPanel'
import { CollectionsPanel, type ShareTarget } from './components/CollectionsPanel'
import { IoPanel } from './components/IoPanel'
import { ShareDialog } from './components/ShareDialog'

type Tab = 'query' | 'headers' | 'body' | 'auth' | 'options' | 'vars'

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
  const [share, setShare] = useState<ShareTarget | null>(null)
  const [toast, setToast] = useState<string | null>(null)

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
      setImportOpen(false)
      return null
    },
    [load]
  )

  const newRequest = useCallback(() => load({ spec: createDefaultSpec() }), [load])

  const openFromCollection = useCallback(
    (target: CurlSpec, ref: OpenRef) => {
      load({ spec: target, ref })
      notify('已从集合取回，改完可以「更新原条目」。')
    },
    [load, notify]
  )

  const boundEntry = useMemo(() => boundEntryOf(colState, wb.activeRef), [colState, wb.activeRef])

  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: 'query', label: 'Query', badge: wb.spec.query.filter((q) => q.enabled && q.key !== '').length },
    { value: 'headers', label: 'Headers', badge: wb.spec.headers.filter((h) => h.enabled && h.key !== '').length },
    { value: 'body', label: 'Body', badge: wb.spec.body.type === 'none' ? 0 : 1 },
    { value: 'auth', label: 'Auth', badge: wb.spec.auth.type === 'none' ? 0 : 1 },
    { value: 'options', label: '选项', badge: wb.spec.rawArgs.length },
    { value: 'vars', label: '变量', badge: Object.keys(vars).length }
  ]

  return (
    <>
      <header className="top">
        <h1>CurlViz</h1>
        <span className="tag">curl 可视化 · 免登录 / 不过云 / 数据全本地</span>
        <div className="grow" />
        <label style={{ margin: 0 }}>
          环境
          <select
            value={envState.activeName ?? ''}
            onChange={(e) =>
              setEnvState((old) => ({
                ...old,
                activeName: old.environments.find((x) => x.name === e.target.value)?.name ?? null
              }))
            }
            style={{ marginLeft: '0.35rem', maxWidth: '10rem' }}
            title="切换当前环境变量集"
          >
            <option value="">不启用</option>
            {envState.environments.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
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
      </header>

      <main>
        <div>
          {persistence.storageIssue && (
            <ul className="notes" style={{ marginBottom: '0.8rem' }}>
              <li className="err">{persistence.storageIssue}</li>
            </ul>
          )}

          <CollectionsPanel
            state={colState}
            environments={envState.environments}
            currentSpec={wb.spec}
            activeRef={wb.activeRef}
            defaultRedact={settings.redactHistory}
            onStateChange={setColState}
            onOpen={openFromCollection}
            onSaved={wb.bind}
            onShare={setShare}
            onNotice={notify}
          />

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
              <button className="mini" onClick={() => setImportOpen((v) => !v)}>
                {importOpen ? '收起导入' : '粘贴 curl 导入'}
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

          {importOpen && <ImportPanel onSubmit={onImport} onClose={() => setImportOpen(false)} />}

          <section className="card">
            <nav className="tabs">
              {tabs.map((t) => (
                <button key={t.value} aria-selected={tab === t.value} onClick={() => setTab(t.value)}>
                  {t.label}
                  {t.badge ? ` (${t.badge})` : ''}
                </button>
              ))}
            </nav>

            {tab === 'query' && (
              <KeyValueTable
                rows={wb.spec.query}
                onChange={(rows) => wb.patch({ query: rows })}
                keyPlaceholder="参数名"
                valuePlaceholder="值"
                pairLabel="参数 / 值"
              />
            )}
            {tab === 'headers' && (
              <KeyValueTable
                rows={wb.spec.headers}
                onChange={(rows) => wb.patch({ headers: rows })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="值（留空输出 K: 表示发空头）"
                pairLabel="头 / 值"
              />
            )}
            {tab === 'body' && <BodyEditor spec={wb.spec} onChange={wb.patch} />}
            {tab === 'auth' && <AuthEditor auth={wb.spec.auth} onChange={(a) => wb.patch({ auth: a })} />}
            {tab === 'options' && (
              <OptionsEditor
                options={wb.spec.options}
                rawArgs={wb.spec.rawArgs}
                onChange={(o) => wb.patch({ options: o })}
                onDropRawArg={(i) => wb.patch({ rawArgs: wb.spec.rawArgs.filter((_, k) => k !== i) })}
              />
            )}
            {tab === 'vars' && <VarsPanel spec={wb.spec} state={envState} onChange={setEnvState} />}
          </section>

          <IoPanel
            colState={colState}
            envState={envState}
            currentSpec={wb.spec}
            currentName={boundEntry?.request ?? wb.spec.name}
            defaultRedact={settings.redactHistory}
            onColState={setColState}
            onEnvState={setEnvState}
            onApplySpec={(s) => load({ spec: s })}
            onImportCurl={onImport}
            onNotice={notify}
          />
        </div>

        <div>
          <CurlPreview
            curl={curl}
            warnings={wb.warnings}
            quoteStyle={settings.quoteStyle}
            onFixQuoteStyle={() => setSettings({ ...settings, quoteStyle: 'windows' })}
          />
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
