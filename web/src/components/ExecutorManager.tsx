import { useState } from 'react'
import type { ExecutorRegistry } from '../lib/executors'

interface Props {
  registry: ExecutorRegistry
  /** 这台在当前会话里已填的 token（落盘那份没有，只能问内存表）。 */
  tokenOf: (id: string) => string
  onAdd: (input: { name: string; baseUrl: string; token: string }) => void
  onUpdate: (id: string, patch: { name?: string; baseUrl?: string }) => void
  onRemove: (id: string) => void
  onSetToken: (id: string, token: string) => void
}

/**
 * 执行机管理弹窗的内容体（外面由 App 套 Overlay）。
 *
 * 名称 / 根地址用"失焦才提交"（defaultValue + onBlur），token 用"边输边进内存表"
 * （onChange）：前者改的是要落盘的注册表，逐字写盘没必要；后者是会话内存，
 * 立刻同步才能让旁边那颗选择器上的"未填 token"实时变。两条是刻意分开的。
 * 字段排布复用选项页那套 .opt-grid（标题列左、输入框右），不另立栅格。
 */
export function ExecutorManager({ registry, tokenOf, onAdd, onUpdate, onRemove, onSetToken }: Props) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')

  const canAdd = name.trim() !== '' && baseUrl.trim() !== ''
  const submit = (): void => {
    if (!canAdd) return
    onAdd({ name, baseUrl, token })
    setName('')
    setBaseUrl('')
    setToken('')
  }

  return (
    <div>
      <h2>执行机</h2>
      <p className="muted">
        在 ECS 上跑一个 agent，选中某台后这条命令就用那台上的真 curl 发出去——不受浏览器跨域限制，
        <span className="mono">-k</span> / <span className="mono">--resolve</span> 这类浏览器发不出的都照常生效。
      </p>

      <section className="opt-sec">
        <h3>新增一台</h3>
        <div className="opt-grid">
          <div>
            <label>名称</label>
            <input value={name} placeholder="ECS-1" spellCheck={false} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>agent 根地址</label>
            <input
              value={baseUrl}
              placeholder="https://ecs-1.internal"
              spellCheck={false}
              title="填 agent 根地址，不带 /exec（发送时自动拼上）"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <label>token</label>
            <input
              value={token}
              placeholder="随 agent 部署的令牌（只留这次会话）"
              spellCheck={false}
              autoComplete="off"
              title="只存在内存里，刷新页面即失效、要重新填；不落盘。"
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <button className="primary" onClick={submit} disabled={!canAdd}>
            添加执行机
          </button>
          <span className="muted">token 留空也能先加，之后在那一台的「会话 token」里补。</span>
        </div>
      </section>

      <section className="opt-sec">
        <h3>已登记 {registry.executors.length} 台</h3>
        {registry.executors.length === 0 && (
          <p className="muted">还没有执行机。上面填一台，或在发送旁那颗选择里点「管理执行机…」。</p>
        )}
        <div className="ex-list">
          {registry.executors.map((ex) => (
            <div key={ex.id} className="ex-card">
              <div className="ex-head">
                <span className="ex-title">{ex.name}</span>
                <span className="grow" />
                <button className="mini" title="删掉这台" onClick={() => onRemove(ex.id)}>
                  ✕
                </button>
              </div>
              <div className="opt-grid">
                <div>
                  <label>名称</label>
                  <input defaultValue={ex.name} spellCheck={false} onBlur={(e) => onUpdate(ex.id, { name: e.target.value })} />
                </div>
                <div>
                  <label>agent 根地址</label>
                  <input
                    defaultValue={ex.baseUrl}
                    spellCheck={false}
                    onBlur={(e) => onUpdate(ex.id, { baseUrl: e.target.value })}
                  />
                </div>
                <div>
                  <label>会话 token{tokenOf(ex.id) === '' ? ' · 未填' : ''}</label>
                  <input
                    defaultValue={tokenOf(ex.id)}
                    placeholder="粘贴这台这次的令牌"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => onSetToken(ex.id, e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="muted">
          刷新页面后各台的 token 都会清空、要重新粘贴——这是有意的：token 等同「以运维身份发任意内网请求」的钥匙，不落到磁盘上。
        </p>
      </section>
    </div>
  )
}

export default ExecutorManager
