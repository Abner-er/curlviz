import { useEffect, useMemo, useState } from 'react'
import { formatBytes, formatMs, prettyJson } from '../lib/response'
import { suggestName } from '../lib/display'
import type { SendReport, SentResponse } from '../types'
import { copyText } from '../lib/clipboard'

type View = 'pretty' | 'raw' | 'headers' | 'html' | 'image'

interface Props {
  report: SendReport | null
  sending: boolean
}

export function ResponsePanel({ report, sending }: Props) {
  const [view, setView] = useState<View>('pretty')
  const resp = report?.outcome.ok ? report.outcome.response : null
  const failure = report && !report.outcome.ok ? report.outcome.failure : null
  const sentAt = report?.sentAt ?? 0

  const views = useMemo(() => {
    if (!resp) return [] as { value: View; label: string }[]
    const list: { value: View; label: string }[] = [
      { value: 'pretty', label: resp.kind === 'json' ? 'JSON' : '美化' },
      { value: 'raw', label: '原文' },
      { value: 'headers', label: `响应头 (${resp.headers.length})` }
    ]
    if (resp.kind === 'html') list.push({ value: 'html', label: '网页预览' })
    if (resp.kind === 'image') list.push({ value: 'image', label: '图片' })
    return list
  }, [resp])

  const active: View = resp && views.some((v) => v.value === view) ? view : (views[0]?.value ?? 'pretty')

  return (
    <section className="card">
      <h2>响应</h2>

      {sending && <p className="muted">请求已发出，等待响应…（浏览器不给建连/ TLS 分段耗时，只能给总耗时）</p>}

      {!report && !sending && <p className="muted">还没发过。填好 URL 点「发送」，或复制到终端里跑。</p>}

      {failure && (
        <>
          <span className="status-pill err">没发出去</span>
          <p style={{ margin: '0.5rem 0 0' }}>{failure.message}</p>
          <p className="muted" style={{ marginTop: '0.3rem' }}>
            {failure.hint}
          </p>
          {failure.raw && (
            <details className="summary">
              <summary>浏览器原始报错</summary>
              <pre className="code">{failure.raw}</pre>
            </details>
          )}
        </>
      )}

      {resp && (
        <>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={`status-pill ${resp.ok ? 'ok' : 'err'}`}>
              {resp.status} {resp.statusText}
            </span>
            <span className="muted">
              首字节 {formatMs(resp.ttfbMs)} · 全程 {formatMs(resp.totalMs)} ·{' '}
              {resp.sizeExact ? '' : '≥'}
              {formatBytes(resp.totalBytes)}
            </span>
            <span className="muted mono">{resp.contentType || '（无 Content-Type）'}</span>
            <button className="mini" onClick={() => void copyText(resp.text)}>
              复制正文
            </button>
            <DownloadButton resp={resp} sentAt={sentAt} />
          </div>

          {resp.truncated && (
            <ul className="notes">
              <li>
                正文超过 512 KB，只显示前 512 KB。要全量请点「下载」，或直接复制到终端重定向到文件。
              </li>
            </ul>
          )}

          {views.length > 0 && (
            <nav className="tabs" style={{ marginTop: '0.6rem' }}>
              {views.map((v) => (
                <button
                  key={v.value}
                  aria-selected={active === v.value}
                  onClick={() => setView(v.value)}
                >
                  {v.label}
                </button>
              ))}
            </nav>
          )}

          {active === 'pretty' && <pre className="code">{resp.kind === 'json' ? prettyJson(resp.text) : resp.text}</pre>}
          {active === 'raw' && <pre className="code">{resp.text}</pre>}
          {active === 'headers' && <HeaderTable resp={resp} />}
          {active === 'html' && <HtmlPreview text={resp.text} />}
          {active === 'image' && <ImagePreview resp={resp} />}
        </>
      )}

      {report && (report.notes.length > 0 || report.blockedHeaders.length > 0) && (
        <details className="summary" open={!!failure}>
          <summary>
            这次发送的注意点（{report.blockedHeaders.length + report.notes.length}）
          </summary>
          <ul className="notes">
            {report.blockedHeaders.length > 0 && (
              <li className="err">
                浏览器禁止脚本设置这些头，本次没有发出：{report.blockedHeaders.join('、')}。要用它们只能复制到终端或走本地
                agent。
              </li>
            )}
            {report.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
            {report.unresolved.length > 0 && (
              <li className="err">变量没填，已按字面量发送：{report.unresolved.join('、')}</li>
            )}
          </ul>
        </details>
      )}
    </section>
  )
}

function HeaderTable({ resp }: { resp: SentResponse }) {
  return (
    <table className="kv">
      <thead>
        <tr>
          <th>名称</th>
          <th>值</th>
        </tr>
      </thead>
      <tbody>
        {resp.headers.map((h, i) => (
          <tr key={i}>
            <td className="mono">{h.name}</td>
            <td className="mono" style={{ wordBreak: 'break-all' }}>
              {h.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * HTML 预览：sandbox 属性一个许可都不给（不执行脚本、不同源、不弹表单、不开新窗），
 * 内容通过 srcdoc 注入。运维粘贴的响应里常带脚本，这条不能松。
 */
function HtmlPreview({ text }: { text: string }) {
  return (
    <>
      <p className="muted">
        预览在完全隔离的沙箱里渲染：不执行脚本、不同源。要看真实效果请另开标签页访问原地址。
      </p>
      <iframe className="preview" sandbox="" referrerPolicy="no-referrer" title="响应 HTML 预览" srcDoc={text} />
    </>
  )
}

function ImagePreview({ resp }: { resp: SentResponse }) {
  const url = useObjectUrl(resp)
  if (!url) return <p className="muted">读不到图片字节。</p>
  return <img src={url} alt="响应图片" style={{ maxWidth: '100%' }} />
}

function useObjectUrl(resp: SentResponse): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (resp.bytes.length === 0) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(
      new Blob([resp.bytes as BlobPart], { type: resp.contentType || 'application/octet-stream' })
    )
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [resp])
  return url
}

function DownloadButton({ resp, sentAt }: { resp: SentResponse; sentAt: number }) {
  const onClick = (): void => {
    const url = URL.createObjectURL(
      new Blob([resp.bytes as BlobPart], { type: resp.contentType || 'application/octet-stream' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = suggestName(sentAt, resp.contentType)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  return (
    <button className="mini" onClick={onClick}>
      下载
    </button>
  )
}
