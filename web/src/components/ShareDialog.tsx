import { useEffect, useMemo, useState } from 'react'
import { buildCollection, normalizeSpec, redactSpec, type CurlSpec, type Environment } from '@curlviz/core'
import type { ShareTarget } from './CollectionsPanel'
import { Overlay } from './Overlay'
import { createPayload, encodeShare, buildShareUrl, shareSizeHint, QR_MAX_BYTES, type SharePayload } from '../lib/share'
import { copyText } from '../lib/clipboard'
import { downloadBytes, downloadText, safeFileName } from '../lib/file'

interface Props {
  target: ShareTarget
  environments: Environment[]
  defaultRedact: boolean
  onClose: () => void
  onNotice: (message: string) => void
}

function prepare(spec: CurlSpec, redact: boolean): CurlSpec {
  const s = normalizeSpec(spec)
  return redact ? redactSpec(s) : s
}

/**
 * 分享弹窗。
 *
 * 三条原则在 lib/share 里已经写死（不过云、自描述、默认脱敏），这里只负责把它们摊给人看：
 *  - 脱敏与"带不带环境变量"是两个独立勾选，而且都必须看得见后果 —— 带上环境时提醒一句
 *    "环境里的值原样出去，脱敏只管 Authorization / Cookie"；
 *  - 长度超了二维码上限就直说"这份只能走链接或导出文件"，不做"缩小一点也许能扫"的猜测；
 *  - 二维码用本地 qrcode 生成（动态 import，不进首屏包），绝不叫在线二维码服务。
 *
 * 弹层本身（portal、Escape、焦点进出、Tab 圈定）是 Overlay 的事，见 hooks/useModalShell。
 */
export function ShareDialog({ target, environments, defaultRedact, onClose, onNotice }: Props) {
  const [redact, setRedact] = useState(defaultRedact)
  const [includeEnvs, setIncludeEnvs] = useState(false)
  const [shareText, setShareText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isCollection = target.kind === 'collection'

  useEffect(() => {
    let alive = true
    setBusy(true)
    setError(null)
    const payload: SharePayload =
      target.kind === 'request'
        ? createPayload('request', prepare(target.spec, redact), redact)
        : createPayload(
            'collection',
            buildCollection(target.collection.requests.map((r) => prepare(r.spec, redact)), includeEnvs ? environments : []),
            redact
          )
    encodeShare(payload)
      .then((text) => {
        if (alive) {
          setShareText(text)
          setBusy(false)
        }
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? `${e.message}；${(e as { hint?: string }).hint ?? ''}` : String(e))
        setBusy(false)
      })
    return () => {
      alive = false
    }
  }, [target, redact, includeEnvs, environments])

  // 二维码是本地算的，但大文本会算很久，而且超上限根本塞不进 QR —— 先量尺寸再决定要不要生成
  useEffect(() => {
    let alive = true
    setQr(null)
    setQrError(null)
    if (shareText === '') return
    const size = shareSizeHint(shareText)
    if (size.bytes > QR_MAX_BYTES) {
      setQrError('内容超过二维码上限，用链接或导出文件。')
      return
    }
    import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(shareText, { margin: 1, width: 460, errorCorrectionLevel: 'M' })
      )
      .then((url) => {
        if (alive) setQr(url)
      })
      .catch((e: unknown) => {
        if (alive) setQrError(`二维码生成失败：${String(e)}`)
      })
    return () => {
      alive = false
    }
  }, [shareText])

  const url = useMemo(() => (shareText === '' ? '' : buildShareUrl(shareText)), [shareText])
  const size = shareText === '' ? null : shareSizeHint(shareText)

  return (
    <Overlay label={`分享「${target.label}」`} onClose={onClose}>
      <h2>
        分享「{target.label}」
        <span className="muted">（{isCollection ? '整个集合' : '单个请求'}）</span>
      </h2>

      <div className="row" style={{ gap: '1rem' }}>
        <label className="inline-check">
          <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />
          抹掉凭据（Authorization / Proxy-Authorization / Cookie）
        </label>
        {isCollection && (
          <label className="inline-check">
            <input type="checkbox" checked={includeEnvs} onChange={(e) => setIncludeEnvs(e.target.checked)} />
            带上环境变量（{environments.length} 个环境）
          </label>
        )}
      </div>
      {!redact && <p className="warn-text">没勾脱敏：token、密码会一起进链接，收的人拿到就是明文。</p>}
      {includeEnvs && redact && (
        <p className="warn-text">
          勾了带环境：脱敏只管请求头里的凭据，环境里的变量值（内网地址、token）会原样带出去，确认过再发。
        </p>
      )}

      {busy && <p className="muted">正在本地压缩…</p>}
      {error && <p className="warn-text">{error}</p>}

      {!busy && !error && shareText !== '' && (
        <>
          <p className="muted">
            {size?.bytes ?? 0} 字节，本地 gzip + base64url 生成，不经过任何服务器
            {isCollection && !includeEnvs ? '，也没带环境变量' : ''}。
            {size?.message ? ` ${size.message}` : ''}
          </p>

          <label>分享链接（对方打开就自动导入）</label>
          <div className="row">
            <input className="grow mono" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button
              className="mini"
              onClick={async () => {
                onNotice((await copyText(url)) ? '链接已复制。' : '没复制上，手动选一下吧。')
              }}
            >
              复制链接
            </button>
          </div>

          <label style={{ marginTop: '0.6rem' }}>分享码（也能贴到群里，本工具认得）</label>
          <textarea rows={4} readOnly spellCheck={false} value={shareText} onFocus={(e) => e.target.select()} />
          <div className="row" style={{ marginTop: '0.4rem' }}>
            <button
              className="mini"
              onClick={async () => {
                onNotice((await copyText(shareText)) ? '分享码已复制。' : '没复制上，手动选一下吧。')
              }}
            >
              复制分享码
            </button>
            <button
              className="mini"
              onClick={() => {
                downloadText(safeFileName([target.label, 'curlviz-share'], '.txt'), shareText, 'text/plain')
              }}
            >
              存成 .txt
            </button>
          </div>

          <div className="qr-box">
            {qr && (
              <>
                <img src={qr} alt="分享二维码" width={230} height={230} />
                <div>
                  <p className="muted">手机扫码即可导入（同一套 curlviz:1: 格式，安卓端也能读）。</p>
                  <button
                    className="mini"
                    onClick={() => {
                      const bytes = atob(qr.split(',')[1] ?? '')
                      const arr = new Uint8Array(bytes.length)
                      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
                      downloadBytes(safeFileName([target.label, 'curlviz-qr'], '.png'), arr, 'image/png')
                    }}
                  >
                    下载二维码 PNG
                  </button>
                </div>
              </>
            )}
            {!qr && <p className="muted">{qrError ?? '二维码生成中…'}</p>}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: '0.8rem' }}>
        <button onClick={onClose}>关闭</button>
        <span className="muted">链接走 #share=，不会进服务端访问日志，也不会被 referer 带出去。</span>
      </div>
    </Overlay>
  )
}
