import { useState } from 'react'
import { redactSpec, type Collection, type CurlSpec } from '@curlviz/core'
import { coerceCollection, environmentsFrom, mergeImported, parseCollectionText, toRequestFile, type CollectionState } from '../lib/collections'
import { mergeEnvironments, type EnvState } from '../lib/environments'
import { buildBackup, looksLikeBackup, mergeBackup, parseBackup, serializeBackup } from '../lib/backup'
import { decodeShare, SHARE_PREFIX } from '../lib/share'
import { downloadText, pickTextFile, readDroppedFile, safeFileName } from '../lib/file'

/** 安全 JSON.parse：坏数据返回 null，让调用方自己决定怎么报错，别在 try 里绕。 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

interface Props {
  colState: CollectionState
  envState: EnvState
  currentSpec: CurlSpec
  currentName: string
  defaultRedact: boolean
  onColState: (next: CollectionState) => void
  onEnvState: (next: EnvState) => void
  onApplySpec: (spec: CurlSpec) => void
  /** curl 文本走 M1 那条解析路径，避免两套解析逻辑并存。 */
  onImportCurl: (text: string) => string | null
  onNotice: (message: string) => void
}

type Outcome = { tone: 'ok' | 'err' | 'warn'; text: string }

/**
 * 导入 / 导出。
 *
 * 导入只给一个输入口，内部按格式分流（备份 → 分享码 → 集合 JSON → curl 命令）。
 * 刻意不做"先选类型再导入"：运维手里拿到的就是一坨文本，让他判断它是哪种格式是本不该有的负担；
 * 分不出来的时候，错误信息里会写清"我把它当成什么试过、为什么不行"。
 */
export function IoPanel({
  colState,
  envState,
  currentSpec,
  currentName,
  defaultRedact,
  onColState,
  onEnvState,
  onApplySpec,
  onImportCurl,
  onNotice
}: Props) {
  const [text, setText] = useState('')
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [redactExport, setRedactExport] = useState(defaultRedact)
  const [redactBackup, setRedactBackup] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const ingest = async (raw: string): Promise<void> => {
    const trimmed = raw.trim()
    if (trimmed === '') return
    setBusy(true)
    setOutcome(null)
    try {
      // 1. 本工具的整体备份
      if (looksLikeBackup(trimmed)) {
        const parsed = parseBackup(trimmed)
        if (!parsed.ok) {
          setOutcome({ tone: 'err', text: parsed.error })
          return
        }
        const merged = mergeBackup(colState, envState, parsed.data)
        onColState(merged.colState)
        onEnvState(merged.envState)
        const bits = [`集合 ${merged.addedCollections} 个 / 请求 ${merged.addedRequests} 条`, `环境 ${merged.addedEnvironments.length ? merged.addedEnvironments.join('、') : '无'}`]
        if (parsed.skipped > 0) bits.push(`跳过 ${parsed.skipped} 条坏数据`)
        if (merged.activeNote) bits.push(merged.activeNote)
        setOutcome({ tone: 'warn', text: `已恢复（全部当新数据入库，没覆盖本机任何东西）：${bits.join('；')}` })
        return
      }

      // 2. 分享码 / 带 #share= 的链接
      if (trimmed.includes(SHARE_PREFIX)) {
        const payload = await decodeShare(trimmed)
        if (payload.kind === 'request' && payload.spec) {
          onApplySpec(payload.spec)
          setOutcome({
            tone: payload.redacted ? 'warn' : 'ok',
            text: payload.redacted ? '已导入这个请求。它是脱敏版，凭据被抹成了 ••••••••，要自己填。' : '已导入这个请求。'
          })
          return
        }
        if (payload.collection) {
          const merged = mergeImported(colState, payload.collection, payload.collection.requests[0]?.name || '分享的集合')
          onColState(merged.state)
          let note = `已把分享来的 ${payload.collection.requests.length} 条请求存成新集合。`
          if (payload.redacted) note += ' 这是脱敏版，凭据要自己填。'
          if (payload.collection.environments.length > 0) {
            const r = mergeEnvironments(envState, environmentsFrom(payload.collection))
            onEnvState(r.state)
            note += ` 附带环境：${r.added.join('、')}。`
          }
          setOutcome({ tone: payload.redacted ? 'warn' : 'ok', text: note })
          return
        }
        setOutcome({ tone: 'err', text: '分享码解开了，但里面既没有请求也没有集合。' })
        return
      }

      // 3. 集合 JSON（或裸 spec 数组 / 单个 spec）
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = parseCollectionText(trimmed)
        let collection: Collection | null = parsed.ok ? parsed.collection : null
        const sensitive = parsed.ok ? parsed.sensitiveCount : 0
        if (collection === null) collection = coerceCollection(tryParseJson(trimmed))
        if (collection === null) {
          setOutcome({ tone: 'err', text: parsed.ok ? '这份集合里没有一条能用的请求。' : `JSON 读得出但本工具认不出来：${parsed.error}` })
          return
        }
        const envs = environmentsFrom(collection)
        const merged = mergeImported(colState, collection)
        onColState(merged.state)
        let note = `已把 ${collection.requests.length - merged.skipped} 条请求作为新集合入库`
        if (merged.skipped > 0) note += `（跳过 ${merged.skipped} 条读不出 URL 的）`
        note += '，没有覆盖本机已有条目。'
        if (sensitive > 0) note += ` 注意：其中 ${sensitive} 条带明文凭据。`
        if (envs.length > 0) {
          const r = mergeEnvironments(envState, envs)
          onEnvState(r.state)
          note += ` 附带环境：${r.added.join('、')}。`
        }
        setOutcome({ tone: sensitive > 0 ? 'warn' : 'ok', text: note })
        return
      }

      // 4. 剩下的当 curl 命令
      const err = onImportCurl(trimmed)
      setOutcome(err ? { tone: 'err', text: err } : { tone: 'ok', text: '已按 curl 命令解析并填入表单。' })
    } catch (e) {
      setOutcome({ tone: 'err', text: `导入失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const exportRequest = (): void => {
    downloadText(safeFileName([currentSpec.name || currentName || 'request'], '.json'), toRequestFile(currentSpec, redactExport))
    onNotice(redactExport ? '已导出当前请求（凭据已抹掉）。' : '已导出当前请求，这份带着明文凭据。')
  }

  const exportBackup = (): void => {
    const data = buildBackup(colState, envState)
    if (redactBackup) {
      // 备份脱敏是显式选择：抹掉之后这份就该按普通文件对待
      data.collections = data.collections.map((c) => ({ ...c, requests: c.requests.map((r) => ({ ...r, spec: redactSpec(r.spec) })) }))
    }
    downloadText(safeFileName(['curlviz-backup'], '.json'), serializeBackup(data))
    onNotice(redactBackup ? '已导出脱敏备份。' : '已导出完整备份 —— 里面有明文 token / 密码，请当密码对待。')
  }

  return (
    <section className="card">
      <h2>导入 / 导出</h2>

      <label>导入（备份 JSON / 分享码 / 集合 JSON / curl 命令，直接粘就行）</label>
      <textarea
        rows={5}
        value={text}
        spellCheck={false}
        placeholder={'curlviz:1:g...\n或 {"format":"curlviz-collection", ...}\n或 curl https://api... -H ...'}
        onChange={(e) => {
          setText(e.target.value)
          setOutcome(null)
        }}
      />
      <div className="row" style={{ marginTop: '0.4rem' }}>
        <button className="primary" disabled={busy || text.trim() === ''} onClick={() => void ingest(text)}>
          {busy ? '解析中…' : '解析并导入'}
        </button>
        <button
          className="mini"
          disabled={busy}
          onClick={() => {
            void pickTextFile().then((picked) => {
              if (!picked) return
              setText(picked.text)
              void ingest(picked.text)
            })
          }}
        >
          选文件…
        </button>
        <div
          className={`drop-zone${dragging ? ' dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files?.[0]
            if (!file) return
            void readDroppedFile(file).then((picked) => {
              if (!picked) {
                setOutcome({ tone: 'err', text: '这个文件太大或读不出来（上限 4 MB）。' })
                return
              }
              setText(picked.text)
              void ingest(picked.text)
            })
          }}
        >
          把 .json / .txt 拖到这里
        </div>
      </div>
      {outcome && (
        <ul className="notes">
          <li className={outcome.tone === 'ok' ? 'ok' : outcome.tone === 'err' ? 'err' : ''}>{outcome.text}</li>
        </ul>
      )}

      <div className="row" style={{ marginTop: '0.9rem', alignItems: 'start' }}>
        <div>
          <div className="inline-check">
            <input type="checkbox" id="redact-export" checked={redactExport} onChange={(e) => setRedactExport(e.target.checked)} />
            <label htmlFor="redact-export" style={{ display: 'inline' }}>
              导出当前请求时抹掉凭据
            </label>
          </div>
          <button className="mini" onClick={exportRequest} disabled={currentSpec.url.trim() === ''}>
            下载当前请求 JSON
          </button>
          {currentSpec.url.trim() === '' && <span className="muted"> URL 还没填，没得导。</span>}
        </div>
        <div>
          <div className="inline-check">
            <input type="checkbox" id="redact-backup" checked={redactBackup} onChange={(e) => setRedactBackup(e.target.checked)} />
            <label htmlFor="redact-backup" style={{ display: 'inline' }}>
              备份时抹掉凭据
            </label>
          </div>
          <button className="mini" onClick={exportBackup} disabled={colState.collections.length === 0 && envState.environments.length === 0}>
            下载完整备份
          </button>
          {!redactBackup && <p className="warn-text">完整备份里有明文 token / 密码与全部环境值，请按密码对待这个文件。</p>}
        </div>
      </div>
      <p className="muted">
        备份是本工具自己的格式（curlviz-backup），换浏览器 / 换机器时把集合与环境一起带走；集合 JSON 才是给别人、给安卓端用的可移植格式。
      </p>
    </section>
  )
}
