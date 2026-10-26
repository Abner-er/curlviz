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
import { HISTORY_LIMIT, KEYS, createStore, browserKeyValue, debounce, memoryKeyValue } from './lib/storage'
import { sendSpec } from './lib/http'
import { CurlPreview } from './components/CurlPreview'
import { ImportPanel } from './components/ImportPanel'
import { ResponsePanel } from './components/ResponsePanel'
import { HistoryPanel } from './components/HistoryPanel'
import { KeyValueTable } from './components/KeyValueTable'
import { AuthEditor, BodyEditor, OptionsEditor } from './components/Editors'
import { VarsPanel } from './components/VarsPanel'

type Tab = 'query' | 'headers' | 'body' | 'auth' | 'options' | 'vars'

const DEFAULT_SETTINGS: Settings = { quoteStyle: 'posix', multiline: true, redactHistory: true }

/** 存储后端：浏览器给不了 localStorage（隐私模式 / file://）就用内存，功能不塌，只如实提示。 */
const store = createStore(browserKeyValue() ?? memoryKeyValue())
const storageAvailable = browserKeyValue() !== null

export function App() {
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...store.load(KEYS.settings, {}) }))
  const [spec, setSpec] = useState<CurlSpec>(() => store.load(KEYS.draft, createDefaultSpec()))
  const [warnings, setWarnings] = useState<ParseWarning[]>([])
  const [vars, setVars] = useState<Record<string, string>>(() => store.load(KEYS.vars, {}))
  const [history, setHistory] = useState<HistoryEntry[]>(() => store.load(KEYS.history, []))
  const [report, setReport] = useState<SendReport | null>(null)
  const [sending, setSending] = useState(false)
  const [tab, setTab] = useState<Tab>('query')
  const [importOpen, setImportOpen] = useState(false)
  const [storageIssue, setStorageIssue] = useState<string | null>(storageAvailable ? null : '本地存储不可用，草稿与历史只在这次会话里有效。')
  const abortRef = useRef<AbortController | null>(null)

  const curl = useMemo(
    () => generateCurl(spec, { quoteStyle: settings.quoteStyle, multiline: settings.multiline }),
    [spec, settings.quoteStyle, settings.multiline]
  )

  const patch = useCallback((p: Partial<CurlSpec>) => setSpec((old) => ({ ...old, ...p })), [])

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
  useEffect(() => {
    store.save(KEYS.vars, vars)
  }, [vars])

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
  }, [])

  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: 'query', label: 'Query', badge: spec.query.filter((q) => q.enabled && q.key !== '').length },
    { value: 'headers', label: 'Headers', badge: spec.headers.filter((h) => h.enabled && h.key !== '').length },
    { value: 'body', label: 'Body', badge: spec.body.type === 'none' ? 0 : 1 },
    { value: 'auth', label: 'Auth', badge: spec.auth.type === 'none' ? 0 : 1 },
    { value: 'options', label: '选项', badge: spec.rawArgs.length },
    { value: 'vars', label: '变量' }
  ]

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
      </header>

      <main>
        <div>
          {storageIssue && (
            <ul className="notes" style={{ marginBottom: '0.8rem' }}>
              <li className="err">{storageIssue}</li>
            </ul>
          )}

          <section className="card">
            <h2>请求</h2>
            <div className="row">
              <div style={{ width: '12rem' }}>
                <label>名称</label>
                <input value={spec.name} onChange={(e) => patch({ name: e.target.value })} />
              </div>
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
            {tab === 'vars' && <VarsPanel spec={spec} vars={vars} onChange={setVars} />}
          </section>
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
    </>
  )
}

export default App
