import type {
  AuthConfig,
  BodyType,
  CurlSpec,
  MultipartParam,
  RequestOptions,
  ResolveEntry
} from '@curlviz/core'
import { applyRowEdit, needsDraftRow } from '../lib/kv-rows'
import { applyResolveEdit, needsDraftResolveRow, urlAuthority } from '../lib/resolve-rows'
import { KeyValueTable } from './KeyValueTable'

interface BodyProps {
  spec: CurlSpec
  onChange: (patch: Partial<CurlSpec>) => void
}

const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'json', label: 'JSON' },
  { value: 'form', label: '表单 (x-www-form-urlencoded)' },
  { value: 'multipart', label: 'multipart (上传)' },
  { value: 'raw', label: '纯文本 / 原始' }
]

export function BodyEditor({ spec, onChange }: BodyProps) {
  const body = spec.body
  const patch = (p: Partial<typeof body>): void => onChange({ body: { ...body, ...p } })

  return (
    <div>
      <div className="row">
        <div style={{ minWidth: '16rem' }}>
          <label>类型</label>
          <select value={body.type} onChange={(e) => patch({ type: e.target.value as BodyType })}>
            {BODY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <span className="muted">切类型不会清空其它类型的内容，来回切回来还在。</span>
      </div>

      {body.type === 'json' && (
        <div style={{ marginTop: '0.6rem' }}>
          <label>JSON 正文（生成时补 Content-Type: application/json，除非你自己写了）</label>
          <textarea
            rows={10}
            value={body.json}
            spellCheck={false}
            onChange={(e) => patch({ json: e.target.value })}
            placeholder='{"key":"value"}'
          />
        </div>
      )}

      {body.type === 'raw' && (
        <div style={{ marginTop: '0.6rem' }}>
          <label>原文（走 --data-binary，一个字节都不改）</label>
          <textarea rows={10} value={body.raw} spellCheck={false} onChange={(e) => patch({ raw: e.target.value })} />
        </div>
      )}

      {body.type === 'form' && (
        <div style={{ marginTop: '0.6rem' }}>
          <KeyValueTable
            rows={body.form}
            onChange={(rows) => patch({ form: rows })}
            keyPlaceholder="字段名"
            valuePlaceholder="值"
            pairLabel="字段 / 值"
          />
          <p className="muted">值里的空格、中文、+ 会被重新编码；想要字节级原样请选「纯文本 / 原始」。</p>
        </div>
      )}

      {body.type === 'multipart' && (
        <div style={{ marginTop: '0.6rem' }}>
          <MultipartTable rows={body.multipart} onChange={(rows) => patch({ multipart: rows })} />
          <p className="muted">
            文件字段填的是路径：浏览器读不到本地文件，这一类请求请用「复制到终端」。
          </p>
        </div>
      )}

      {body.type === 'none' && <p className="muted">这条请求不带 body。</p>}
    </div>
  )
}

/** 草稿行的形状。只读：写的时候一律经 applyRowEdit 展开成新对象。 */
const BLANK_MULTIPART: MultipartParam = { key: '', kind: 'text', value: '', enabled: true }

function MultipartTable({
  rows,
  onChange
}: {
  rows: MultipartParam[]
  onChange: (rows: MultipartParam[]) => void
}) {
  // 与键值表同一套草稿行算术。只看 key/value：只填了 filename 没填字段名的行本来就还不完整，
  // 代价是这种半截行当下不会被再补一行空白，补齐字段名后下一格才长出草稿行
  const body: MultipartParam[] = needsDraftRow(rows) ? [...rows, BLANK_MULTIPART] : rows
  const set = (i: number, patch: Partial<MultipartParam>): void =>
    onChange(applyRowEdit(rows, i, BLANK_MULTIPART, patch))

  return (
    <div>
      <table className="kv">
        <thead>
          <tr>
            <th style={{ width: '2.2rem' }}>发</th>
            <th>字段</th>
            <th style={{ width: '7rem' }}>类型</th>
            <th>值 / 文件路径</th>
            <th>filename</th>
            <th>type</th>
            <th style={{ width: '3rem' }} />
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => set(i, { enabled: e.target.checked })}
                  aria-label={`发送第 ${i + 1} 项`}
                />
              </td>
              <td>
                <input value={r.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="file" />
              </td>
              <td>
                <select
                  value={r.kind}
                  onChange={(e) => set(i, { kind: e.target.value as 'text' | 'file' })}
                  aria-label="类型"
                >
                  <option value="text">文本</option>
                  <option value="file">文件</option>
                </select>
              </td>
              <td>
                <input
                  value={r.value}
                  onChange={(e) => set(i, { value: e.target.value })}
                  placeholder={r.kind === 'file' ? '/data/report.pdf' : '张三'}
                />
              </td>
              <td>
                <input
                  value={r.filename ?? ''}
                  onChange={(e) => set(i, { filename: e.target.value })}
                  placeholder="可选"
                  disabled={r.kind !== 'file'}
                />
              </td>
              <td>
                <input
                  value={r.contentType ?? ''}
                  onChange={(e) => set(i, { contentType: e.target.value })}
                  placeholder="application/pdf"
                />
              </td>
              <td>
                {/* 草稿行不在 rows 里，没有"删掉它"这回事：打字那一刻它才成为一行 */}
                {i < rows.length && (
                  <button className="mini" onClick={() => onChange(rows.filter((_, k) => k !== i))} title="删除">
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 「指定解析」（`--resolve <host>:<port>:<addr>`）两列表，可加多条。
 *
 * 端口不在这里填：curl 的 --resolve 三段虽都必需，但常态下 host 与端口就等于请求 URL 里的，
 * 用户真正要决定的只有 IP。所以新行的 host/端口由 URL 打底（seed 传进 applyResolveEdit），
 * 只有 addr（IP）是"这行算不算真数据"的触发字段（见 lib/resolve-rows）。
 * core 里每条 resolve 都会输出，没有 enabled 位，所以只留删除、不留勾选。
 */
function ResolveTable({
  rows,
  urlHost,
  urlPort,
  onChange
}: {
  rows: ResolveEntry[]
  urlHost: string
  urlPort: number
  onChange: (rows: ResolveEntry[]) => void
}) {
  const seed: ResolveEntry = { host: urlHost, port: urlPort, addr: '' }
  const body: ResolveEntry[] = needsDraftResolveRow(rows) ? [...rows, seed] : rows
  const set = (i: number, patch: Partial<ResolveEntry>): void => onChange(applyResolveEdit(rows, i, patch, seed))

  return (
    <table className="kv">
      <thead>
        <tr>
          <th>域名 host</th>
          <th style={{ width: '20rem' }}>解析到的 IP</th>
          <th style={{ width: '3rem' }} />
        </tr>
      </thead>
      <tbody>
        {body.map((row, i) => (
          <tr key={i}>
            <td>
              <input
                value={row.host}
                onChange={(e) => set(i, { host: e.target.value })}
                placeholder={urlHost || 'api.example.com'}
              />
            </td>
            <td>
              <input
                className="mono"
                value={row.addr}
                onChange={(e) => set(i, { addr: e.target.value })}
                placeholder={'93.184.216.34 或 [2001:db8::1]'}
              />
            </td>
            <td>
              {/* 草稿行不在 rows 里，没有"删掉它"这回事：填上 IP 那一刻它才成为一行 */}
              {i < rows.length && (
                <button className="mini" onClick={() => onChange(rows.filter((_, k) => k !== i))} title="删除">
                  ✕
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function AuthEditor({ auth, onChange }: { auth: AuthConfig; onChange: (a: AuthConfig) => void }) {
  return (
    <div>
      <label>方式</label>
      <select value={auth.type} onChange={(e) => onChange({ ...auth, type: e.target.value as AuthConfig['type'] })}>
        <option value="none">无</option>
        <option value="basic">Basic（用户名 + 密码 → -u）</option>
        <option value="bearer">Bearer（token → Authorization 头）</option>
      </select>

      {auth.type === 'basic' && (
        <div className="row" style={{ marginTop: '0.6rem' }}>
          <div className="grow">
            <label>用户名</label>
            <input
              value={auth.basic.username}
              onChange={(e) => onChange({ ...auth, basic: { ...auth.basic, username: e.target.value } })}
            />
          </div>
          <div className="grow">
            <label>密码</label>
            <input
              type="password"
              value={auth.basic.password}
              onChange={(e) => onChange({ ...auth, basic: { ...auth.basic, password: e.target.value } })}
            />
          </div>
        </div>
      )}

      {auth.type === 'bearer' && (
        <div style={{ marginTop: '0.6rem' }}>
          <label>Token</label>
          <input
            value={auth.bearer.token}
            onChange={(e) => onChange({ ...auth, bearer: { ...auth.bearer, token: e.target.value } })}
            placeholder="{{token}}"
          />
        </div>
      )}

      {auth.type !== 'none' && (
        <p className="muted">
          这里填的认证会接管 Authorization 头：Headers 表里同名的那条在生成时不会再输出，避免 curl 真的发两个。
        </p>
      )}
    </div>
  )
}

export function OptionsEditor({
  options,
  rawArgs,
  url,
  onChange,
  onDropRawArg
}: {
  options: RequestOptions
  rawArgs: string[]
  url: string
  onChange: (o: RequestOptions) => void
  onDropRawArg: (index: number) => void
}) {
  const set = (patch: Partial<RequestOptions>): void => onChange({ ...options, ...patch })
  const num = (v: string): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
  }
  const { host: urlHost, port: urlPort } = urlAuthority(url)

  return (
    <div className="opts">
      <section className="opt-sec">
        <h3>传输行为</h3>
        <div className="opt-checks">
          <label className="inline-chk">
            <input
              type="checkbox"
              checked={options.followRedirects}
              onChange={(e) => set({ followRedirects: e.target.checked })}
            />
            -L 跟随重定向
          </label>
          <label className="inline-chk">
            <input type="checkbox" checked={options.insecure} onChange={(e) => set({ insecure: e.target.checked })} />
            -k 跳过证书校验
          </label>
          <label className="inline-chk">
            <input type="checkbox" checked={options.compressed} onChange={(e) => set({ compressed: e.target.checked })} />
            --compressed 压缩
          </label>
        </div>
        <div className="opt-grid">
          <div>
            <label>
              总时限 <span className="mono">-m</span>
            </label>
            <input
              type="number"
              min={0}
              step={100}
              value={options.timeoutMs}
              onChange={(e) => set({ timeoutMs: num(e.target.value) })}
              placeholder="毫秒，0=不限"
            />
          </div>
          <div>
            <label>
              建连时限 <span className="mono">--connect-timeout</span>
            </label>
            <input
              type="number"
              min={0}
              step={100}
              value={options.connectTimeoutMs}
              onChange={(e) => set({ connectTimeoutMs: num(e.target.value) })}
              placeholder="毫秒，0=系统默认"
            />
          </div>
        </div>
      </section>

      <section className="opt-sec">
        <h3>身份与代理</h3>
        <div className="opt-grid">
          <div>
            <label>
              自定义 UA <span className="mono">-A</span>
            </label>
            <input
              value={options.userAgent}
              onChange={(e) => set({ userAgent: e.target.value })}
              placeholder="留空 = curl 默认 UA"
            />
          </div>
          <div>
            <label>
              代理 <span className="mono">-x</span>
            </label>
            <input
              value={options.proxy}
              onChange={(e) => set({ proxy: e.target.value })}
              placeholder="http://127.0.0.1:8888"
            />
          </div>
        </div>
      </section>

      <section className="opt-sec">
        <h3>
          指定解析 <span className="mono">--resolve</span>
        </h3>
        <ResolveTable
          rows={options.resolve}
          urlHost={urlHost}
          urlPort={urlPort}
          onChange={(resolve) => set({ resolve })}
        />
        <p className="muted">
          把某个域名钉到指定 IP（写成 v4/v6 字面量，v6 带方括号）。端口沿用上方地址栏（当前{' '}
          <span className="mono">
            {urlHost || '—'}:{urlPort}
          </span>
          ），不必在此填；填成主机名或非法值 curl 会报 (49)。IP 留空的行不输出。
        </p>
      </section>

      {rawArgs.length > 0 && (
        <section className="opt-sec">
          <h3>原样保留的片段</h3>
          <p className="muted">本工具还没法变成字段的 flag，复制时会照原样带上。</p>
          <ul className="notes">
            {rawArgs.map((raw, i) => (
              <li key={i} className="mono" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span className="grow">{raw}</span>
                <button className="mini" onClick={() => onDropRawArg(i)} title="不要这一段了">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
