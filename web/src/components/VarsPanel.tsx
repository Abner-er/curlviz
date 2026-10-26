import { useMemo, useState } from 'react'
import type { CurlSpec } from '@curlviz/core'
import { usedVars } from '../lib/display'
import {
  activeEnv,
  addEnv,
  commitRows,
  removeEnv,
  renameEnv,
  rowsForEditor,
  setActive,
  setVars,
  varOrigin,
  varsFor,
  type EnvState
} from '../lib/environments'
import { KeyValueTable } from './KeyValueTable'

/** select 里代表「不启用任何环境」的取值；真实环境名不可能长这样。 */
const NO_ENV = '\u0000none'

interface Props {
  spec: CurlSpec
  state: EnvState
  onChange: (next: EnvState) => void
}

/**
 * 变量 / 环境面板。
 *
 * 面板只做两件事：把「当前激活环境」的变量表摊开让人填，以及把环境的增删改切清楚。
 * 所有取值语义都来自 lib/environments（它又来自 core 的 toVarMap），
 * 界面这里不额外发明规则 —— 否则 web 与安卓两边会对不上。
 */
export function VarsPanel({ spec, state, onChange }: Props) {
  const [drafting, setDrafting] = useState<'new' | 'rename' | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const used = useMemo(() => usedVars(spec), [spec])
  const env = activeEnv(state)
  const effective = useMemo(() => varsFor(state), [state])
  const rows = useMemo(() => rowsForEditor(env, used), [env, used])

  // 命令里写了、但按当前分层算不出值的那些
  const missing = used.filter((k) => (effective[k] ?? '') === '')

  const startDraft = (mode: 'new' | 'rename'): void => {
    setDrafting(mode)
    setDraftName(mode === 'rename' ? (env?.name ?? '') : '')
  }

  const commitDraft = (): void => {
    if (drafting === 'new') {
      const created = addEnv(state, draftName)
      onChange(setActive(created.state, created.name))
    } else if (drafting === 'rename' && env) {
      onChange(renameEnv(state, env.name, draftName))
    }
    setDrafting(null)
    setDraftName('')
  }

  return (
    <div>
      <p className="muted">
        命令里写 <code className="mono">{'{{名字}}'}</code>，发送前按当前环境替换。内网地址、token 换环境只改这里，不用改命令。
      </p>

      <div className="row" style={{ marginBottom: '0.5rem' }}>
        <div style={{ width: '13rem' }}>
          <label>当前环境</label>
          <select
            value={state.activeName ?? NO_ENV}
            onChange={(e) => onChange(setActive(state, e.target.value === NO_ENV ? null : e.target.value))}
          >
            <option value={NO_ENV}>不启用环境（变量原样发出）</option>
            {state.environments.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name}
                {e.variables.length > 0 ? `（${e.variables.length}）` : ''}
              </option>
            ))}
          </select>
        </div>
        {drafting === null ? (
          <>
            <button
              className="mini"
              onClick={() => startDraft('new')}
              title="复制一份变量表，换一套地址与凭据"
            >
              ＋新建环境
            </button>
            <button className="mini" disabled={!env} onClick={() => startDraft('rename')}>
              重命名
            </button>
            <button
              className="mini"
              disabled={!env}
              onClick={() => {
                if (!env) return
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                onChange(removeEnv(state, env.name))
                setConfirmDelete(false)
              }}
              title={confirmDelete ? '再点一次确认删除' : '删除当前环境及其变量'}
            >
              {confirmDelete ? `确认删除「${env?.name ?? ''}」？` : '删除环境'}
            </button>
          </>
        ) : (
          <>
            <div className="grow">
              <label>{drafting === 'new' ? '新环境名' : `把「${env?.name ?? ''}」改名为`}</label>
              <input
                autoFocus
                value={draftName}
                placeholder={drafting === 'new' ? '例如 测试' : ''}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitDraft()
                  if (e.key === 'Escape') {
                    setDrafting(null)
                    setDraftName('')
                  }
                }}
              />
            </div>
            <button className="mini primary" disabled={draftName.trim() === ''} onClick={commitDraft}>
              确定
            </button>
            <button
              className="mini"
              onClick={() => {
                setDrafting(null)
                setDraftName('')
              }}
            >
              取消
            </button>
          </>
        )}
      </div>

      <ul className="notes" style={{ marginTop: 0 }}>
        <li>
          分层规则：当前环境里有的变量以其为准；当前环境没有的，其它环境里有值就拿来兜底。要彻底不替换，把上面选成「不启用环境」。
        </li>
      </ul>

      {state.activeName === null ? (
        <p className="muted">
          没有启用环境，{used.length > 0 ? `命令里的 ${used.length} 个变量会按字面量发出去` : '这条命令也没有变量'}。
        </p>
      ) : (
        <KeyValueTable
          rows={rows}
          onChange={(next) => {
            if (!env) return
            setConfirmDelete(false)
            onChange(setVars(state, env.name, commitRows(env, next)))
          }}
          keyPlaceholder="变量名"
          valuePlaceholder="值"
          pairLabel="变量 / 值"
        />
      )}

      {missing.length > 0 && (
        <ul className="notes">
          <li className="err">
            还没赋值：
            {missing
              .map((k) => {
                const from = varOrigin(state, k)
                if (state.activeName === null) return from ? `${k}（在「${from}」环境里，但没启用）` : k
                if (from && from !== state.activeName) return `${k}（「${from}」环境里有，当前环境没覆盖）`
                return k
              })
              .join('、')}
            ，这几个会原样发出去。
          </li>
        </ul>
      )}
    </div>
  )
}
