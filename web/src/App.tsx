import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CurlParseError,
  KNOWN_METHODS,
  cloneSpec,
  createDefaultSpec,
  generateCurl,
  hasSensitive,
  parseCurl,
  redactSpec,
  suggestName,
  type CurlSpec,
  type ParseWarning
} from '@curlviz/core'
import type { HistoryEntry, SendReport, Settings } from './types'
import { HISTORY_LIMIT, KEYS, createStore, browserKeyValue, debounce, memoryKeyValue, type StoreKey } from './lib/storage'
import { sendSpec } from './lib/http'
import { varsFor, type EnvState } from './lib/environments'
import { NO_OPEN_REF, type CollectionState, type OpenRef } from './lib/collections'
import { applySharePayload, hasShareHash, loadBootState } from './lib/bootstrap'
import { decodeShare, ShareError } from './lib/share'
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

/** 存储后端：浏览器给不了 localStorage（隐私模式 / file://）就用内存，功能不塌，只如实提示。 */
const store = createStore(browserKeyValue() ?? memoryKeyValue())
const storageAvailable = browserKeyValue() !== null
/** 坏数据收敛 + M1 旧变量迁移 + openRef 校验都在 bootstrap 里，顺序是有依赖的。 */
const boot = loadBootState(store)

export function App() {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...store.load(KEYS.settings, {}) }))
  const [spec, setSpec] = useState<CurlSpec>(() => store.load(KEYS.draft, createDefaultSpec()))
  const [warnings, setWarnings] = useState<ParseWarning[]>([])
  const [envState, setEnvState] = useState<EnvState>(() => boot.envState)
  const [colState, setColState] = useState<CollectionState>(() => boot.colState)
  const [activeRef, setActiveRef] = useState<OpenRef>(() => boot.openRef)
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.load(KEYS.history, []))
  const [report, setReport] = useState<SendReport | null>(null)
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState<Tab>('query')
  const [importOpen, setImportOpen] = useState(false)
  const [share, setShare] = useState<ShareTarget | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [storageIssue, setStorageIssue] = useState<string | null>(storageAvailable ? null : '本地存储不可用，草稿与历史只在这次会话里有效。')
  const abortRef = useRef<AbortController | null>(null)

  // 这次生效的变量表：激活环境优先，其它环境兜底（语义来自 core 的 toVarMap）
  const vars = useMemo(() => varsFor(envState), [envState])

  const curl = useMemo(
    () => generateCurl(spec, { quoteStyle: settings.quoteStyle, multiline: settings.multiline }),
    [spec, settings.quoteStyle, settings.multiline]
  )

  const patch = useCallback((p: Partial<CurlSpec>) => setSpec((old) => ({ ...old, ...p })), [])

  const notify = useCallback((message: string) => setToast(message), [])
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  // 启动提示：M1 的扁平变量搬进环境后要删掉旧键，否则每次开机都重复迁一遍
  useEffect(() => {
    if (boot.didMigrate) store.remove(KEYS.vars)
    if (boot.note) setToast(boot.note)
  }, [])

  // 草稿防抖落盘：每敲一个键就写 localStorage 会明显卡，而且没必要
  const persistDraft = useMemo(() => debounce((s: CurlSpec) => {
    const r = store.save(KEYS.draft, s)
    if (!r.ok) setStorageIssue(`本地存储写入失败（${r.reason === 'quota' ? '空间不足' : '不可用'}），草稿可能留不住。`)
  }, 500), [])
  useEffect(() => {
    persistDraft(spec)
  }, [spec, persistDraft])
  useEffect(() => {
    store.save(KEYS.settings, settings)
  }, [settings])

  /** 集合 / 环境 / 打开位置是"用户的资料库"，写失败必须说清楚，不能假装存好了。 */
  const persist = useCallback((key: StoreKey, value: unknown, label: string) => {
    const r = store.save(key, value)
    if (!r.ok) {
      setStorageIssue(`${label}写入本地存储失败（${r.reason === 'quota' ? '空间不足' : '不可用'}），这部分改动关掉页面就没了。`)
    }
  }, [])
  useEffect(() => persist(KEYS.environments, envState, '环境变量'), [envState, persist])
  useEffect(() => persist(KEYS.collections, colState, '集合'), [colState, persist])
  useEffect(() => persist(KEYS.openRef, activeRef, '打开位置'), [activeRef, persist])

  // 链接里带 #share= 时开机直接导入：这是"同事发你一条命令"最短的路
  useEffect(() => {
    const hash = globalThis.location?.hash ?? ''
    if (!hasShareHash(hash)) return
    let cancelled = false
    decodeShare(hash)
      .then((payload) => {
        if (cancelled) return
        const applied = applySharePayload(payload, colState, envState)
        if (applied.spec) {
          setSpec(applied.spec)
          setActiveRef(NO_OPEN_REF)
        }
        if (applied.collectionId) setColState(applied.colState)
        setEnvState(applied.envState)
        setWarnings([])
        setToast(applied.note)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setToast(e instanceof ShareError ? `${e.message}（${e.hint}）` : `分享链接解不开：${String(e)}`)
      })
      .finally(() => {
        // 必须把 hash 抹掉：不然刷新一次就重复导入一次，集合里会多出一样的集合
        const loc = globalThis.location
        if (globalThis.history?.replaceState && loc) {
          globalThis.history.replaceState(null, '', loc.pathname + loc.search)
        }
      })
    return () => {
      cancelled = true
    }
    // 只在挂载那一次处理分享链接，后续状态变化不该再触发导入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSend = useCallback(async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setSending(true)
    setReport(null)
    const r = await sendSpec(spec, {
      vars,
      generate: { quoteStyle: settings.quoteStyle, multiline: settings.multiline },
      signal: controller.signal
    })
    abortRef.current = null
    setSending(false)
    setReport(r)
    setHistory((old) => {
      const ok = r.outcome.ok
      const entry: HistoryEntry = {
        id: `${r.sentAt}-${Math.random().toString(36).slice(2, 8)}`,
        at: r.sentAt,
        spec: settings.redactHistory && hasSensitive(spec) ? redactSpec(spec) : cloneSpec(spec),
        redacted: settings.redactHistory && hasSensitive(spec),
        result: ok
          ? { status: r.outcome.response.status, ok: r.outcome.response.ok, ms: r.outcome.response.totalMs }
          : { error: r.outcome.failure.message }
      }
      const next = [entry, ...old].slice(0, HISTORY_LIMIT)
      const res = store.save(KEYS.history, next)
      if (!res.ok) setStorageIssue(`历史写入失败（${res.reason === 'quota' ? '空间不足' : '不可用'}），只保留在这次会话里。`)
      return next
    })
  }, [spec, vars, settings])

  const onCancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Ctrl/Cmd+Enter 发送：运维改一条命令要按几十次，少一次鼠标位移
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && spec.url.trim() !== '' && !sending) {
        e.preventDefault()
        void onSend()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSend, sending, spec.url])

  const onImport = useCallback((text: string): string | null => {
    try {
      const result = parseCurl(text)
      setSpec(result.spec)
      setWarnings(result.warnings)
      setImportOpen(false)
      // 粘进来的新命令跟集合里没有关系，绑定要清掉，否则"更新原条目"会改错东西
      setActiveRef(NO_OPEN_REF)
      if (result.spec.name === '' || result.spec.name === '未命名请求') patch({ name: suggestName(result.spec) })
      return null
    } catch (e) {
      if (e instanceof CurlParseError) return `解析失败：${e.message}`
      return `解析失败：${String(e)}`
    }
  }, [patch])

  const newRequest = useCallback(() => {
    setSpec(createDefaultSpec())
    setWarnings([])
    setReport(null)
    setActiveRef(NO_OPEN_REF)
  }, [])

  const openFromCollection = useCallback((target: CurlSpec, ref: OpenRef) => {
    setSpec(cloneSpec(target))
    setActiveRef(ref)
    setWarnings([])
    setReport(null)
    notify('已从集合取回，改完可以「更新原条目」。')
  }, [notify])

  const boundEntry = useMemo(() => {
    if (activeRef.collectionId === null || activeRef.requestId === null) return null
    const col = colState.collections.find((c) => c.id === activeRef.collectionId)
    const req = col?.requests.find((r) => r.id === activeRef.requestId)
    if (!col || !req) return null
    return { collection: col.name, request: req.spec.name || '未命名请求' }
  }, [colState, activeRef])

  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: 'query', label: 'Query', badge: spec.query.filter((q) => q.enabled && q.key !== '').length },
    { value: 'headers', label: 'Headers', badge: spec.headers.filter((h) => h.enabled && h.key !== '').length },
    { value: 'body', label: 'Body', badge: spec.body.type === 'none' ? 0 : 1 },
    { value: 'auth', label: 'Auth', badge: spec.auth.type === 'none' ? 0 : 1 },
    { value: 'options', label: '选项', badge: spec.rawArgs.length },
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
                activeName:
                  old.environments.find((x) => x.name === e.target.value)?.name ?? null
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
          {storageIssue && (
            <ul className="notes" style={{ marginBottom: '0.8rem' }}>
              <li className="err">{storageIssue}</li>
            </ul>
          )}

          <CollectionsPanel
            state={colState}
            environments={envState.environments}
            currentSpec={spec}
            activeRef={activeRef}
            defaultRedact={settings.redactHistory}
            onStateChange={setColState}
            onOpen={openFromCollection}
            onSaved={setActiveRef}
            onShare={setShare}
            onNotice={notify}
          />

          <section className="card">
            <h2>请求</h2>
            <div className="row">
              <div style={{ width: '12rem' }}>
                <label>名称</label>
                <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
              </div>
              {boundEntry && (
                <span className="muted" style={{ paddingBottom: '0.4rem' }}>
                  编辑自「{boundEntry.collection}」的 {boundEntry.request}
                </span>
              )}
            </div>
            <div className="url-bar" style={{ marginTop: '0.5rem' }}>
              <select
                value={KNOWN_METHODS.includes(spec.method as (typeof KNOWN_METHODS)[number]) ? spec.method : 'CUSTOM'}
                onChange={(e) => {
                  if (e.target.value !== 'CUSTOM') patch({ method: e.target.value })
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
                value={spec.method}
                onChange={(e) => patch({ method: e.target.value.toUpperCase() })}
                aria-label="方法名"
                title="curl 不限制方法名，可以直接改"
              />
              <input
                className="url grow"
                value={spec.url}
                placeholder="https://internal.api/v1/list"
                spellCheck={false}
                onChange={(e) => patch({ url: e.target.value })}
                aria-label="URL"
              />
              {sending ? (
                <button onClick={onCancel}>取消</button>
              ) : (
                <button className="primary" onClick={() => void onSend()} disabled={spec.url.trim() === ''}>
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
                onClick={() => setShare({ kind: 'request', spec, label: spec.name || '当前请求' })}
                disabled={spec.url.trim() === ''}
                title="生成链接 / 二维码，对方打开就导入（默认脱敏，本地生成）"
              >
                分享这条
              </button>
              <span className="muted">Ctrl+Enter 发送</span>
            </div>
            {spec.url.trim() === '' && <p className="muted">填了 URL 才能发送。</p>}
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
                rows={spec.query}
                onChange={(rows) => patch({ query: rows })}
                keyPlaceholder="参数名"
                valuePlaceholder="值"
                pairLabel="参数 / 值"
              />
            )}
            {tab === 'headers' && (
              <KeyValueTable
                rows={spec.headers}
                onChange={(rows) => patch({ headers: rows })}
                keyPlaceholder="Header-Name"
                valuePlaceholder="值（留空输出 K: 表示发空头）"
                pairLabel="头 / 值"
              />
            )}
            {tab === 'body' && <BodyEditor spec={spec} onChange={patch} />}
            {tab === 'auth' && <AuthEditor auth={spec.auth} onChange={(a) => patch({ auth: a })} />}
            {tab === 'options' && (
              <OptionsEditor
                options={spec.options}
                rawArgs={spec.rawArgs}
                onChange={(o) => patch({ options: o })}
                onDropRawArg={(i) => patch({ rawArgs: spec.rawArgs.filter((_, k) => k !== i) })}
              />
            )}
            {tab === 'vars' && <VarsPanel spec={spec} state={envState} onChange={setEnvState} />}
          </section>

          <IoPanel
            colState={colState}
            envState={envState}
            currentSpec={spec}
            currentName={boundEntry?.request ?? spec.name}
            defaultRedact={settings.redactHistory}
            onColState={setColState}
            onEnvState={setEnvState}
            onApplySpec={(s) => {
              setSpec(s)
              setActiveRef(NO_OPEN_REF)
              setWarnings([])
            }}
            onImportCurl={onImport}
            onNotice={notify}
          />
        </div>

        <div>
          <CurlPreview
            curl={curl}
            warnings={warnings}
            quoteStyle={settings.quoteStyle}
            onFixQuoteStyle={() => setSettings({ ...settings, quoteStyle: 'windows' })}
          />
          <ResponsePanel report={report} sending={sending} />
          <HistoryPanel
            items={history}
            quoteStyle={settings.quoteStyle}
            multiline={settings.multiline}
            onPick={(e) => {
              setSpec(cloneSpec(e.spec))
              setWarnings([])
              setActiveRef(NO_OPEN_REF)
            }}
            onDelete={(id) => {
              const next = history.filter((h) => h.id !== id)
              setHistory(next)
              store.save(KEYS.history, next)
            }}
            onClear={() => {
              setHistory([])
              store.remove(KEYS.history)
            }}
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
