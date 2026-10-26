import { useMemo, useState } from 'react'
import type { CurlSpec, Environment } from '@curlviz/core'
import {
  addCollection,
  duplicateRequest,
  removeCollection,
  removeRequest,
  renameCollection,
  requestCount,
  saveRequest,
  moveRequest,
  toCollectionFile,
  type CollectionState,
  type OpenRef,
  type StoredCollection,
  type StoredRequest
} from '../lib/collections'
import { downloadText, safeFileName } from '../lib/file'

export type { OpenRef } from '../lib/collections'

export type ShareTarget =
  | { kind: 'request'; spec: CurlSpec; label: string }
  | { kind: 'collection'; collection: StoredCollection; label: string }

interface Props {
  state: CollectionState
  environments: Environment[]
  currentSpec: CurlSpec
  activeRef: OpenRef
  defaultRedact: boolean
  onStateChange: (next: CollectionState) => void
  /** 把集合里的某条取回编辑器；ref 一并交给上层，好支持"改完就地更新"。 */
  onOpen: (spec: CurlSpec, ref: OpenRef) => void
  onSaved: (ref: OpenRef) => void
  onShare: (target: ShareTarget) => void
  onNotice: (message: string) => void
}

/**
 * 集合库。
 *
 * 一切增删改都调 lib/collections 里的纯函数，再把新状态交回上层落盘 ——
 * 组件自己不碰 localStorage，这样"导入会不会覆盖我的东西"这类策略能在 node 里测掉。
 */
export function CollectionsPanel({
  state,
  environments,
  currentSpec,
  activeRef,
  defaultRedact,
  onStateChange,
  onOpen,
  onSaved,
  onShare,
  onNotice
}: Props) {
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [saveTarget, setSaveTarget] = useState<string>('')

  const targetId = useMemo(() => {
    if (saveTarget && state.collections.some((c) => c.id === saveTarget)) return saveTarget
    if (activeRef.collectionId) return activeRef.collectionId
    return state.collections[0]?.id ?? ''
  }, [saveTarget, state.collections, activeRef.collectionId])

  const boundRequest = useMemo(() => {
    if (!activeRef.collectionId || !activeRef.requestId) return null
    const col = state.collections.find((c) => c.id === activeRef.collectionId)
    return col?.requests.find((r) => r.id === activeRef.requestId) ?? null
  }, [state.collections, activeRef])

  const toggle = (id: string): void =>
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const doSave = (overwrite: boolean): void => {
    if (targetId === '') {
      onNotice('还没有集合，先建一个再存。')
      return
    }
    const r = saveRequest(state, targetId, currentSpec, overwrite ? (activeRef.requestId ?? undefined) : undefined)
    onStateChange(r.state)
    onSaved({ collectionId: targetId, requestId: r.id })
    onNotice(overwrite && !r.created ? '已更新原条目。' : `已保存到「${state.collections.find((c) => c.id === targetId)?.name ?? ''}」。`)
  }

  const exportCollection = (col: StoredCollection): void => {
    downloadText(
      safeFileName([col.name, 'curlviz-collection'], '.json'),
      toCollectionFile(col, defaultRedact, environments)
    )
    onNotice(defaultRedact ? '已导出（凭据已抹掉）。' : '已导出，注意这份带着明文凭据。')
  }

  return (
    <section className="card">
      <h2>
        集合（{state.collections.length} 个 / {requestCount(state)} 条请求，只存这台机器）
      </h2>

      {state.collections.length === 0 && (
        <p className="muted">
          还没有存过请求。调通一条以后点「存入当前集合」就能反复用；换环境只改「变量」页，命令不用动。
        </p>
      )}

      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <div className="grow">
          <label>保存到</label>
          <select value={targetId} onChange={(e) => setSaveTarget(e.target.value)}>
            {state.collections.length === 0 && <option value="">（还没有集合）</option>}
            {state.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.requests.length}）
              </option>
            ))}
          </select>
        </div>
        <button className="mini primary" onClick={() => doSave(false)} disabled={targetId === ''}>
          存入
        </button>
        <button
          className="mini"
          onClick={() => doSave(true)}
          disabled={boundRequest === null}
          title={boundRequest ? `覆盖「${boundRequest.spec.name}」` : '先从集合里打开一条，才能就地更新'}
        >
          更新原条目
        </button>
        {creating ? (
          <>
            <div className="grow">
              <label>新集合名</label>
              <input
                autoFocus
                value={newName}
                placeholder="例如 生产巡检"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim() !== '') {
                    const r = addCollection(state, newName)
                    onStateChange(r.state)
                    setSaveTarget(r.id)
                    setNewName('')
                    setCreating(false)
                  }
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
              />
            </div>
            <button
              className="mini primary"
              disabled={newName.trim() === ''}
              onClick={() => {
                const r = addCollection(state, newName)
                onStateChange(r.state)
                setSaveTarget(r.id)
                setNewName('')
                setCreating(false)
              }}
            >
              建
            </button>
            <button className="mini" onClick={() => setCreating(false)}>
              取消
            </button>
          </>
        ) : (
          <button className="mini" onClick={() => setCreating(true)}>
            ＋新建集合
          </button>
        )}
      </div>

      {state.collections.map((col) => {
        const open = !collapsed.has(col.id)
        return (
          <div key={col.id} className="col-block">
            <div className="col-head">
              <button className="mini caret" onClick={() => toggle(col.id)} aria-label={open ? '收起' : '展开'}>
                {open ? '▾' : '▸'}
              </button>
              {renamingId === col.id ? (
                <>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onStateChange(renameCollection(state, col.id, renameDraft))
                        setRenamingId(null)
                      }
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    style={{ flex: '1 1 8rem', minWidth: '8rem' }}
                  />
                  <button
                    className="mini primary"
                    onClick={() => {
                      onStateChange(renameCollection(state, col.id, renameDraft))
                      setRenamingId(null)
                    }}
                  >
                    确定
                  </button>
                  <button className="mini" onClick={() => setRenamingId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <strong>{col.name}</strong>
                  <span className="muted">{col.requests.length} 条</span>
                  <div className="grow" />
                  <button
                    className="mini"
                    onClick={() => {
                      setRenamingId(col.id)
                      setRenameDraft(col.name)
                    }}
                  >
                    改名
                  </button>
                  <button className="mini" onClick={() => onShare({ kind: 'collection', collection: col, label: col.name })}>
                    分享
                  </button>
                  <button className="mini" onClick={() => exportCollection(col)} title="导出成 JSON 文件">
                    导出
                  </button>
                  <button
                    className="mini"
                    onClick={() => {
                      if (confirmDeleteId !== col.id) {
                        setConfirmDeleteId(col.id)
                        return
                      }
                      onStateChange(removeCollection(state, col.id))
                      setConfirmDeleteId(null)
                      if (activeRef.collectionId === col.id) onSaved({ collectionId: null, requestId: null })
                    }}
                    title={confirmDeleteId === col.id ? '再点一次确认删除这个集合' : '删除集合（不改已存请求以外的东西）'}
                  >
                    {confirmDeleteId === col.id ? `确认删「${col.name}」？` : '删除'}
                  </button>
                </>
              )}
            </div>

            {open && (
              <ul className="history">
                {col.requests.length === 0 && <li className="muted">空集合。</li>}
                {col.requests.map((req) => (
                  <RequestRow
                    key={req.id}
                    req={req}
                    bound={boundRequest?.id === req.id}
                    others={state.collections.filter((c) => c.id !== col.id)}
                    onOpen={() => onOpen(req.spec, { collectionId: col.id, requestId: req.id })}
                    onDuplicate={() => onStateChange(duplicateRequest(state, col.id, req.id).state)}
                    onRemove={() => {
                      onStateChange(removeRequest(state, col.id, req.id))
                      if (activeRef.requestId === req.id) onSaved({ collectionId: col.id, requestId: null })
                    }}
                    onShare={() => onShare({ kind: 'request', spec: req.spec, label: req.spec.name || col.name })}
                    onMove={(toId) => onStateChange(moveRequest(state, col.id, req.id, toId))}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </section>
  )
}

interface RowProps {
  req: StoredRequest
  bound: boolean
  others: StoredCollection[]
  onOpen: () => void
  onDuplicate: () => void
  onRemove: () => void
  onShare: () => void
  onMove: (toId: string) => void
}

function RequestRow({ req, bound, others, onOpen, onDuplicate, onRemove, onShare, onMove }: RowProps) {
  const [confirm, setConfirm] = useState(false)
  return (
    <li>
      <button className="mini" onClick={onOpen} title="取回编辑器">
        打开
      </button>
      <span className="u" title={`${req.spec.method} ${req.spec.url}`}>
        {req.spec.name || '未命名请求'}
        <span className="muted">
          {' '}
          · {req.spec.method} {req.spec.url}
        </span>
      </span>
      {bound && <span className="tag-mini">编辑器里就是它</span>}
      <span className="muted">{new Date(req.updatedAt).toLocaleDateString('zh-CN')}</span>
      <button className="mini" onClick={onShare}>
        分享
      </button>
      <button className="mini" onClick={onDuplicate} title="在同一集合里复制一份">
        复制
      </button>
      {others.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value !== '') onMove(e.target.value)
          }}
          title="移到别的集合"
          style={{ minWidth: '5.5rem' }}
        >
          <option value="">移到…</option>
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <button
        className="mini"
        onClick={() => {
          if (!confirm) {
            setConfirm(true)
            return
          }
          onRemove()
        }}
        title={confirm ? '再点一次确认删除' : '删除这一条'}
      >
        {confirm ? '确认？' : '✕'}
      </button>
    </li>
  )
}
