/**
 * curl 命令 → CurlSpec（解析方向）。
 *
 * 结构分三步，刻意不混在一起：
 *   A. 定位命令：跳过 `FOO=bar curl ...` 的前缀赋值，遇到 `;` `|` `&` 或第二个 curl 收尾。
 *   B. getopt 展开：把 token 序列展开成规范化的 Arg[]（短选项粘连 `-sSL`、`-XGET`、
 *      `-H=v`、`--long=value` 全部在这一层归一化）。
 *   C. 分发组装：按规范名查一张表决定"映射进 CurlSpec"还是"进 rawArgs"。
 *
 * 三条硬规则：
 *   1. 认得但 CurlSpec 表达不了的 flag（-s/-v/-o/--retry/--cacert…）连值一起进 rawArgs，
 *      保证复制到终端的行为等价，不被悄悄改掉。
 *   2. Authorization 头识别成 auth 后必须从 headers 移除，否则生成时 `-u` 与 `-H` 同时
 *      输出，curl 会真发两个认证头。
 *   3. 未知长选项默认"带值"处理（`--cacert ./ca.pem`），否则 ./ca.pem 会被当成 URL；
 *      已知布尔集优先，避免把 URL 吞掉。
 */

import { tokenize, type Token } from './tokenizer'
import { encodeKeepingVars } from './generate'
import {
  CurlParseError,
  createParseDefaultSpec,
  type CurlSpec,
  type MultipartParam,
  type Param,
  type ParseResult,
  type ParseWarning,
  type RequestBody
} from './types'

type ArgKind = 'value' | 'bool' | 'unknown'

/** 展开后的单个命令行参数。 */
interface Arg {
  /** 规范名（长选项名，短选项已映射过来），不含前导 `-`。 */
  name: string
  kind: ArgKind
  /** 原始 flag token，rawArgs 保真时用。 */
  flag: Token
  /** 取值：内联（`--k=v` / `-XGET`）或下一个 token。 */
  value: string | null
  valueToken: Token | null
  /** 原始写法，用于日志与 UI 提示。 */
  source: string
}

/** 短选项 → 规范长名 + 是否带值（curl 官方 -h 列表整理）。 */
const SHORT: Record<string, [name: string, kind: Exclude<ArgKind, 'unknown'>]> = {
  A: ['user-agent', 'value'],
  b: ['cookie', 'value'],
  c: ['cert', 'value'],
  C: ['continue-at', 'value'],
  D: ['dump-header', 'value'],
  d: ['data', 'value'],
  e: ['referer', 'value'],
  F: ['form', 'value'],
  f: ['fail', 'bool'],
  g: ['globoff', 'bool'],
  G: ['get', 'bool'],
  H: ['header', 'value'],
  h: ['help', 'bool'],
  i: ['include', 'bool'],
  I: ['head', 'bool'],
  J: ['junk-session-cookies', 'bool'],
  k: ['insecure', 'bool'],
  L: ['location', 'bool'],
  l: ['list-only', 'bool'],
  m: ['max-time', 'value'],
  M: ['manual', 'bool'],
  n: ['netrc', 'bool'],
  N: ['no-buffer', 'bool'],
  o: ['output', 'value'],
  O: ['remote-name', 'bool'],
  p: ['proxytunnel', 'bool'],
  q: ['disable', 'bool'],
  Q: ['quote', 'value'],
  r: ['range', 'value'],
  s: ['silent', 'bool'],
  S: ['show-error', 'bool'],
  t: ['ftp-ssl', 'bool'],
  T: ['upload-file', 'value'],
  u: ['user', 'value'],
  U: ['proxy-user', 'value'],
  v: ['verbose', 'bool'],
  V: ['version', 'bool'],
  w: ['write-out', 'value'],
  x: ['proxy', 'value'],
  X: ['request', 'value'],
  y: ['speed-limit', 'value'],
  Y: ['speed-time', 'value'],
  z: ['time-cond', 'value'],
  Z: ['blocking', 'bool'],
  '0': ['http1.0', 'bool'],
  '1': ['socks4', 'bool'],
  '2': ['socks5', 'bool'],
  '3': ['http3', 'bool']
}

/** 映射进 CurlSpec 的长选项。 */
const MAPPED: Record<string, Exclude<ArgKind, 'unknown'>> = {
  request: 'value',
  header: 'value',
  data: 'value',
  'data-ascii': 'value',
  'data-raw': 'value',
  'data-binary': 'value',
  'data-urlencode': 'value',
  'url-query': 'value',
  form: 'value',
  'form-string': 'value',
  user: 'value',
  'user-agent': 'value',
  cookie: 'value',
  referer: 'value',
  proxy: 'value',
  location: 'bool',
  'no-location': 'bool',
  'location-trusted': 'bool',
  insecure: 'bool',
  compressed: 'bool',
  head: 'bool',
  get: 'bool',
  'connect-timeout': 'value',
  'max-time': 'value',
  url: 'value'
}

/** 已知长选项：布尔（必须先于启发式，否则 `--http2 https://x` 会把 URL 吞成值）。 */
const KNOWN_BOOL: string[] = [
  'anyauth',
  'basic',
  'blocking',
  'compressed',
  'create-dirs',
  'digest',
  'disable',
  'fail',
  'fail-early',
  'fail-with-body',
  'ftp-ssl',
  'get',
  'globoff',
  'head',
  'help',
  'http1',
  'http1.0',
  'http1.1',
  'http2',
  'http2-prior-knowledge',
  'http3',
  'ignore-content-length',
  'include',
  'insecure',
  'ipv4',
  'ipv6',
  'junk-session-cookies',
  'keepalive',
  'list-only',
  'location',
  'location-trusted',
  'manual',
  'negotiate',
  'netrc',
  'netrc-optional',
  'no-alpn',
  'no-buffer',
  'no-keepalive',
  'no-location',
  'no-nominal-time',
  'no-progress',
  'no-sessionid',
  'oauth2-bearer',
  'post301',
  'post302',
  'post303',
  'post307',
  'progress-bar',
  'proto-skip',
  'proxy-tlsauthtype',
  'proxytunnel',
  'raw',
  'remote-header-name',
  'remote-name',
  'remote-name-all',
  'remove-on-error',
  'retry-all-errors',
  'retry-connrefused',
  'socks4',
  'socks5',
  'show-error',
  'silent',
  'spnego',
  'ssl',
  'ssl-allow-beast',
  'ssl-no-revoke',
  'styled',
  'tcp-fastopen',
  'tcp-nodelay',
  'tls-authtype',
  'unsup',
  'use-ascii',
  'verbose',
  'version'
]

/** 已知长选项：带值。 */
const KNOWN_VALUE: string[] = [
  'cacert',
  'capath',
  'cert',
  'cert-type',
  'continue-at',
  'cookie',
  'cookie-jar',
  'crlfile',
  'curlrc',
  'deleg',
  'doh-url',
  'dump-header',
  'expect100-timeout',
  'resolve',
  'ftp-account',
  'ftp-alternative-to-user',
  'ftp-method',
  'ftp-ssl-ccc-mode',
  'hat',
  'interface',
  'key',
  'key-type',
  'libcurl',
  'limit-rate',
  'local-port',
  'mail-from',
  'mail-rcpt',
  'mail-rcpt-allowfails',
  'max-filesize',
  'max-redirs',
  'maxtime',
  'netrc-file',
  'noproxy',
  'output-dir',
  'pass',
  'passphrase',
  'pinnedpubkey',
  'preproxy',
  'proto',
  'proto-redir',
  'proxy-anyauth',
  'proxy-cacert',
  'proxy-capath',
  'proxy-cert',
  'proxy-cert-type',
  'proxy-ciphers',
  'proxy-crlfile',
  'proxy-header',
  'proxy-insecure',
  'proxy-key',
  'proxy-key-type',
  'proxy-negotiate',
  'proxy-ntlm',
  'proxy-pass',
  'proxy-pinnedpubkey',
  'proxy-service-name',
  'proxy-tlspassword',
  'proxy-tlsuser',
  'proxy-user',
  'quote',
  'random-file',
  'range',
  'referer',
  'request',
  'retry',
  'retry-delay',
  'retry-max-time',
  'sasl-authzid',
  'sasl-ir',
  'service-name',
  'socks4',
  'socks4a',
  'socks5',
  'socks5-gssapi-nec',
  'socks5-gssapi-service',
  'socks5-hostname',
  'speed-limit',
  'speed-time',
  'ssh-auth',
  'ssh-host-key-md5',
  'ssl-cipher',
  'ssl-sessionid',
  'stderr',
  'suppress-connect-headers',
  'time-cond',
  'timeout',
  'tls-ciphers',
  'tls-ciphersuites',
  'tls-max',
  'tls-usernames',
  'trace',
  'trace-ascii',
  'trace-time',
  'unix-socket',
  'upload-file',
  'user',
  'url',
  'write-out',
  'xattr',
  'ciphers',
  'curves',
  'algos'
]

const BOOL_SET = new Set(KNOWN_BOOL)
const VALUE_SET = new Set(KNOWN_VALUE.concat(Object.keys(MAPPED)))

/* ================================================================== */
/* B. getopt 展开                                                      */
/* ================================================================== */

function kindOfLong(name: string): Exclude<ArgKind, 'unknown'> {
  if (name in MAPPED) return MAPPED[name] ?? 'value'
  if (BOOL_SET.has(name)) return 'bool'
  if (VALUE_SET.has(name)) return 'value'
  // 完全未知：按带值处理（见文件头规则 3），布尔型未知项靠 BOOL_SET 兜住
  return 'value'
}

/** 下一个 token 是否可以当作"值"被吞掉。 */
function canBeValue(token: Token | undefined): boolean {
  if (!token) return false
  const v = token.value
  if (v === '') return true
  if (v.startsWith('-') && !/^-[\d.]/.test(v)) return false
  // 看起来像下一条命令的开头就不吞
  if (isCurlWord(v)) return false
  return true
}

function expandArgs(tokens: Token[]): { args: Arg[]; urls: Token[] } {
  const args: Arg[] = []
  const urls: Token[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    const value = token.value

    if (value === '--') {
      // 选项结束，其后全是位置参数
      for (let k = i + 1; k < tokens.length; k++) urls.push(tokens[k] as Token)
      break
    }

    if (value.startsWith('--')) {
      const eq = value.indexOf('=')
      const name = (eq === -1 ? value.slice(2) : value.slice(2, eq)).toLowerCase()
      const kind = kindOfLong(name)
      if (kind === 'bool') {
        args.push({ name, kind, flag: token, value: null, valueToken: null, source: value })
        continue
      }
      if (eq !== -1) {
        args.push({
          name,
          kind,
          flag: token,
          value: value.slice(eq + 1),
          valueToken: token,
          source: value
        })
        continue
      }
      const next = tokens[i + 1]
      if (next && canBeValue(next)) {
        i++
        args.push({ name, kind, flag: token, value: next.value, valueToken: next, source: value })
      } else {
        args.push({ name, kind, flag: token, value: null, valueToken: null, source: value })
      }
      continue
    }

    if (value.startsWith('-') && value.length > 1) {
      // 短选项粘连：-sSL / -XGET / -H=v / -bs cookie
      const body = value.slice(1)
      let consumed = false
      for (let k = 0; k < body.length; k++) {
        const ch = body[k] as string
        const mapped = SHORT[ch]
        if (!mapped) {
          args.push({
            name: `?${ch}`,
            kind: 'unknown',
            flag: token,
            value: null,
            valueToken: null,
            source: `-${ch}`
          })
          // 未知短选项：尝试吞一个值（贴近 getopt 行为）
          const rest = body.slice(k + 1)
          if (rest === '') {
            const next = tokens[i + 1]
            if (next && canBeValue(next) && !looksLikeUrl(next.value)) {
              i++
              ;(args[args.length - 1] as Arg).value = next.value
              ;(args[args.length - 1] as Arg).valueToken = next
            }
          }
          consumed = true
          break
        }
        const [name, kind] = mapped
        if (kind === 'bool') {
          args.push({ name, kind, flag: token, value: null, valueToken: null, source: `-${ch}` })
          continue
        }
        let inline: string | null = body.slice(k + 1)
        if (inline.startsWith('=')) inline = inline.slice(1)
        if (inline !== '') {
          args.push({ name, kind, flag: token, value: inline, valueToken: token, source: `-${ch}` })
        } else {
          const next = tokens[i + 1]
          if (next && canBeValue(next)) {
            i++
            args.push({ name, kind, flag: token, value: next.value, valueToken: next, source: `-${ch}` })
          } else {
            args.push({ name, kind, flag: token, value: null, valueToken: null, source: `-${ch}` })
          }
        }
        consumed = true
        break
      }
      if (consumed) continue
      continue
    }

    urls.push(token)
  }

  return { args, urls }
}

/* ================================================================== */
/* C. 分发组装                                                         */
/* ================================================================== */

class Assembler {
  readonly spec: CurlSpec = createParseDefaultSpec()
  readonly warnings: ParseWarning[] = []
  private headers: Param[] = []
  private dataItems: { name: string; value: string; flagText: string; flag: Token; valueToken: Token }[] = []
  private getFlag = false
  /** `-I` 的原始 Arg；null 表示没出现过。留着是为了能被回填进 rawArgs（用归一化的 source）。 */
  private headArg: Arg | null = null
  private explicitMethod: string | null = null
  /** 与 explicitMethod 对应的原始 `-X` Arg，冲突回填时要用。 */
  private explicitArg: Arg | null = null
  private authUserValue: string | null = null
  /** 多个 `-b` 的值，按 curl 的规则用 "; " 拼成一个 Cookie 头。 */
  private readonly cookieValues: string[] = []
  /** 第一条 `-b` 出现时 headers 的长度——Cookie 头插回这里，保持"按命令顺序填字段"。 */
  private cookieAnchor = -1

  warn(code: ParseWarning['code'], message: string, at?: number): void {
    this.warnings.push({ code, message, at })
  }

  dispatch(args: Arg[], urls: Token[]): void {
    for (const arg of args) {
      // 替换几乎都出现在"值"里（-H "Authorization: Bearer $TOKEN"），只查 flag 等于永远不报
      const carrier = arg.flag.hasSubstitution ? arg.flag : (arg.valueToken ?? arg.flag)
      if (carrier.hasSubstitution) {
        this.warn(
          'shell-substitution',
          `含 shell 变量或命令替换，已保留原文但不保证等价：${carrier.raw}`,
          carrier.start
        )
      }
      this.handle(arg)
    }

    if (this.spec.url === '' && urls.length > 0) {
      const first = urls[0] as Token
      this.spec.url = first.value
      for (let k = 1; k < urls.length; k++) {
        const extra = urls[k] as Token
        this.warn('extra-url', `多个 URL 位置参数，curl 会依次请求，本工具只取第一个，其余原样保留`, extra.start)
        this.spec.rawArgs.push(extra.raw)
      }
    } else if (urls.length > 0) {
      for (const u of urls) {
        this.warn('extra-url', `额外的 URL，已原样保留`, u.start)
        this.spec.rawArgs.push(u.raw)
      }
    }
  }

  private keep(arg: Arg): void {
    const separate = arg.valueToken !== null && arg.valueToken !== arg.flag
    // 用归一化的 source：bundled 短选项（-sSL）的 flag.raw 是整串，重复回吐会写三遍
    this.spec.rawArgs.push(separate ? `${arg.source} ${(arg.valueToken as Token).raw}` : arg.source)
  }

  private keepPair(flagRaw: string, valueRaw: string | null): void {
    this.spec.rawArgs.push(valueRaw === null ? flagRaw : `${flagRaw} ${valueRaw}`)
  }

  private handle(arg: Arg): void {
    switch (arg.name) {
      case 'request':
        if (arg.value === null) return this.missing(arg)
        this.explicitMethod = arg.value.toUpperCase()
        this.explicitArg = arg
        return
      case 'header':
        if (arg.value === null) return this.missing(arg)
        this.addHeader(arg.value, arg)
        return
      case 'data':
      case 'data-ascii':
      case 'data-raw':
      case 'data-binary':
      case 'data-urlencode': {
        if (arg.value === null) return this.missing(arg)
        const valueToken = arg.valueToken ?? arg.flag
        this.dataItems.push({ name: arg.name, value: arg.value, flagText: arg.source, flag: arg.flag, valueToken })
        return
      }
      case 'form':
      case 'form-string': {
        if (arg.value === null) return this.missing(arg)
        this.formItemValues ??= []
        this.formItemValues.push({
          flag: arg.flag,
          valueToken: arg.valueToken ?? arg.flag,
          value: arg.value,
          textOnly: arg.name === 'form-string'
        })
        return
      }
      case 'user':
        if (arg.value === null) return this.missing(arg)
        this.authUserValue = arg.value
        return
      case 'user-agent':
        if (arg.value === null) return this.missing(arg)
        this.spec.options.userAgent = arg.value
        return
      case 'cookie':
        if (arg.value === null) return this.missing(arg)
        // 实测 curl 8.19.0：多个 -b 用 "; " 拼成**一个** Cookie 头（`-b a=1 -b b=2` → `a=1; b=2`）。
        // 旧写法是给每条 push 一个 Cookie 头、再由 dedupe 用 ',' 拼接，
        // 于是线上发成 `a=1,b=2`——Cookie 头变成非法形状，服务端直接认不出。
        this.cookieValues.push(arg.value)
        if (this.cookieAnchor === -1) this.cookieAnchor = this.headers.length
        return
      case 'url-query': {
        if (arg.value === null) return this.missing(arg)
        const eq = arg.value.indexOf('=')
        this.spec.query.push(
          eq === -1
            ? { key: arg.value, value: '', enabled: true, viaUrlQuery: true }
            : {
                key: arg.value.slice(0, eq),
                value: arg.value.slice(eq + 1),
                enabled: true,
                viaUrlQuery: true
              }
        )
        return
      }
      case 'referer':
        if (arg.value === null) return this.missing(arg)
        this.headers.push({ key: 'Referer', value: arg.value, enabled: true })
        return
      case 'proxy':
        if (arg.value === null) return this.missing(arg)
        this.spec.options.proxy = arg.value
        return
      case 'location':
        this.spec.options.followRedirects = true
        return
      case 'no-location':
        this.spec.options.followRedirects = false
        return
      case 'location-trusted':
        this.spec.options.followRedirects = true
        this.warn('unknown-flag', '--location-trusted 与 -L 的差别无法用布尔表达，已按 -L 处理', arg.flag.start)
        this.spec.rawArgs.push(arg.flag.raw)
        return
      case 'insecure':
        this.spec.options.insecure = true
        return
      case 'compressed':
        this.spec.options.compressed = true
        return
      case 'head':
        this.headArg = arg
        return
      case 'get':
        this.getFlag = true
        return
      case 'connect-timeout':
        if (arg.value === null) return this.missing(arg)
        this.spec.options.connectTimeoutMs = secondsToMs(arg.value)
        return
      case 'max-time':
        if (arg.value === null) return this.missing(arg)
        this.spec.options.timeoutMs = secondsToMs(arg.value)
        return
      case 'url':
        if (arg.value === null) return this.missing(arg)
        if (this.spec.url === '') this.spec.url = arg.value
        else this.spec.rawArgs.push(`${arg.flag.raw} ${arg.valueToken?.raw ?? ''}`.trim())
        return
      default: {
        // 认得但不映射（-s/-v/-o/--retry/--cacert…）与完全未知，一律原样保留
        this.keep(arg)
        const known = BOOL_SET.has(arg.name) || VALUE_SET.has(arg.name)
        if (!known) {
          this.warn('unknown-flag', `未识别的选项 ${arg.source}，已原样保留`, arg.flag.start)
        }
      }
    }
  }

  private missing(arg: Arg): void {
    this.warn('malformed', `${arg.source} 缺少参数，已忽略`, arg.flag.start)
    this.spec.rawArgs.push(arg.flag.raw)
  }

  private formItemValues?: {
    flag: Token
    valueToken: Token
    value: string
    textOnly: boolean
  }[]

  private addHeader(raw: string, arg: Arg): void {
    if (raw.endsWith(';')) {
      this.keep(arg)
      this.warn('unknown-flag', `-H "名字;" 形态（发送无冒号头）已原样保留`, arg.flag.start)
      return
    }
    const colon = raw.indexOf(':')
    if (colon === -1) {
      this.keep(arg)
      this.warn('malformed', `-H "${raw}" 缺少冒号，已原样保留`, arg.flag.start)
      return
    }
    const key = raw.slice(0, colon).trim()
    const value = raw.slice(colon + 1).replace(/^ /, '')
    if (key.toLowerCase() === 'content-type') {
      const dup = this.headers.find((h) => h.key.toLowerCase() === 'content-type')
      if (dup) {
        dup.value = value
        return
      }
    }
    this.headers.push({ key, value, enabled: true })
  }

  /**
   * 把 `-b` 们合成一个 Cookie 头，插回第一条 `-b` 所在的位置。
   *
   * 实测 curl 8.19.0：
   *   - `-b 'x=1;y=2' -b 'z=3'` 发出去的是**一个** `Cookie: x=1;y=2; z=3`（连接符是 "; "）。
   *   - Cookie 永远排在自定义 `-H` 之前，与 `-b` 写在 `-H` 前还是后无关
   *     （`-b a=1 -H 'X-A: 1'` 与 `-H 'X-A: 1' -b a=1` 线上头序完全相同）。
   *   - 同一条命令里另有 `-H 'Cookie: …'` 时 curl 让 -H 赢、-b 被丢弃。
   * 这里按"命令出现顺序"插回锚点：既符合上面的观察，也让 `-b -e` 这类命令
   * 生成的 `-H` 顺序和用户手写的一致。
   */
  private applyCookies(): void {
    if (this.cookieValues.length === 0) return
    if (this.headers.some((h) => h.key.toLowerCase() === 'cookie')) {
      this.warn(
        'flag-conflict',
        `-H 'Cookie: …' 与 -b 同时出现，curl 以 -H 为准，${this.cookieValues.length} 个 -b 已丢弃`
      )
      return
    }
    const at = this.cookieAnchor === -1 ? this.headers.length : this.cookieAnchor
    this.headers.splice(at, 0, { key: 'Cookie', value: this.cookieValues.join('; '), enabled: true })
  }

  /** 把已经原样保留过的 -d 系列重新写回 rawArgs（值用原始 token 文本，不重编码）。 */
  private keepData(d: { flagText: string; flag: Token; valueToken: Token }): void {
    this.keepPair(d.flagText, d.valueToken !== d.flag ? d.valueToken.raw : null)
  }

  /** 收尾：Cookie、认证、body、方法，全部在这里定型。 */
  finalize(): void {
    this.applyCookies()
    // 不再合并同名头：实测 curl 8.19.0 对 `-H 'X-A: 1' -H 'X-A: 2'` 是**发两行**，
    // 旧的 dedupe 拼成 `X-A: 1,2` 等于改了请求。（Content-Type 的"取后者"另有一套，见 addHeader。）
    this.spec.headers = this.headers
    this.applyAuth()
    this.applyBody()
    this.spec.method = this.pickMethod()
    // 记下用户是否真的写了 -X：隐式 POST 补上 -X 会改重定向语义，见 types.ts 的 methodExplicit。
    // HEAD 例外：生成器对 HEAD 永远输出 -I（`-X HEAD` 会死等响应体），
    // 显式性带不下去，留着会让往返第二次从 true 翻成 false，破坏幂等契约。
    this.spec.methodExplicit = this.explicitMethod !== null && this.spec.method !== 'HEAD'
    // -I 被 -X 抢掉时（curl -I url -X GET），不能静默吞掉：原样留在 rawArgs 里，
    // 重新生成时还会带上，用户看得见。
    if (this.headArg !== null && this.spec.method !== 'HEAD') {
      this.keep(this.headArg)
      // `-X` 不再回填：现在 methodExplicit=true 时生成器自己就会输出 `-X METHOD`，
      // 留下原文会变成两条 -X（旧规则是"GET 不输出 -X"，那时才需要回填）。
      this.warn(
        'flag-conflict',
        `${this.headArg.source} 与 ${this.explicitArg?.source ?? '-X'} ${this.spec.method} 同时出现，方法按 -X 取 ${this.spec.method}，${this.headArg.source} 原样保留`,
        this.headArg.flag.start
      )
    }
    if (this.spec.url === '') {
      throw new CurlParseError('命令里没有 URL', 0, '')
    }
    splitUrlQuery(this.spec)
  }

  private pickMethod(): string {
    if (this.explicitMethod) return this.explicitMethod
    if (this.headArg !== null) return 'HEAD'
    if (this.getFlag) return 'GET'
    if (this.dataItems.length > 0 || (this.formItemValues?.length ?? 0) > 0) return 'POST'
    return 'GET'
  }

  private applyAuth(): void {
    if (this.authUserValue !== null) {
      const v = this.authUserValue
      const colon = v.indexOf(':')
      this.spec.auth.type = 'basic'
      this.spec.auth.basic =
        colon === -1 ? { username: v, password: '' } : { username: v.slice(0, colon), password: v.slice(colon + 1) }
    }

    const idx = this.spec.headers.findIndex((h) => h.key.toLowerCase() === 'authorization')
    if (idx === -1) return
    const header = this.spec.headers[idx] as Param
    const value = header.value.trim()

    if (this.spec.auth.type !== 'none') {
      this.warn('malformed', '同时给了 -u 与 Authorization 头，已采用 -u，Authorization 保留为普通头')
      return
    }

    const bearer = /^Bearer\s+([\s\S]+)$/i.exec(value)
    if (bearer?.[1]) {
      this.spec.auth.type = 'bearer'
      this.spec.auth.bearer.token = (bearer[1] as string).trim()
      this.spec.headers.splice(idx, 1)
      return
    }
    const basic = /^Basic\s+(\S+)$/i.exec(value)
    if (basic?.[1]) {
      const decoded = tryBase64Decode(basic[1] as string)
      if (decoded !== null) {
        const colon = decoded.indexOf(':')
        this.spec.auth.type = 'basic'
        this.spec.auth.basic =
          colon === -1
            ? { username: decoded, password: '' }
            : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
        this.spec.headers.splice(idx, 1)
        return
      }
      this.warn('malformed', 'Authorization: Basic 的值不是合法 base64，已保留为普通头')
    }
  }

  private applyBody(): void {
    const multipartValues = this.formItemValues ?? []

    if (multipartValues.length > 0) {
      this.spec.body.type = 'multipart'
      this.spec.body.multipart = multipartValues.map((m) => parseMultipartArg(m.value, m.textOnly))
      if (this.dataItems.length > 0) {
        this.warn('malformed', '-F 与 -d 混用，body 取 multipart，-d 原样保留')
        for (const d of this.dataItems) this.keepData(d)
      }
      return
    }

    if (this.dataItems.length === 0) {
      this.spec.body = emptyBody()
      return
    }

    // -G：data 语义变成 query
    if (this.getFlag) {
      for (const item of this.dataItems) {
        if (item.name === 'data-urlencode') {
          const eq = item.value.indexOf('=')
          this.spec.query.push(
            eq === -1
              ? { key: item.value, value: '', enabled: true }
              : { key: item.value.slice(0, eq), value: item.value.slice(eq + 1), enabled: true }
          )
          continue
        }
        for (const p of splitFormPairs(item.value)) this.spec.query.push(p)
      }
      this.spec.body = emptyBody()
      return
    }

    // @file 读不到内容：不猜，原样保留
    const fileRefs = this.dataItems.filter((d) => d.name !== 'data-raw' && d.value.startsWith('@'))
    if (fileRefs.length > 0) {
      this.warn('unknown-flag', '-d @file / --data-binary @file 需要本地文件，已原样保留为 rawArgs')
      for (const f of fileRefs) this.keepData(f)
      const rest = this.dataItems.filter((d) => !fileRefs.includes(d))
      if (rest.length === 0) {
        this.spec.body = emptyBody()
        return
      }
      this.dataItems = rest
    }

    const urlencode = this.dataItems.filter((d) => d.name === 'data-urlencode')
    const plain = this.dataItems.filter((d) => d.name !== 'data-urlencode')

    if (urlencode.length > 0 && plain.length === 0) {
      // 全是 --data-urlencode：可无损落到 form
      this.spec.body.type = 'form'
      this.spec.body.form = urlencode.map((u) => {
        const eq = u.value.indexOf('=')
        return eq === -1
          ? { key: u.value, value: '', enabled: true }
          : { key: u.value.slice(0, eq), value: u.value.slice(eq + 1), enabled: true }
      })
      if (urlencode.some((u) => /^[@<]/.test(u.value) || !u.value.includes('='))) {
        this.warn('data-urlencode-lossy', '--data-urlencode 的 @file / 裸内容形态按 name=value 近似映射，已尽力保留')
      }
      return
    }
    if (urlencode.length > 0) {
      this.warn('data-urlencode-lossy', '--data-urlencode 与普通 -d 混用，urlencode 部分原样保留')
      for (const u of urlencode) this.keepData(u)
    }

    // curl 的语义：多个 -d 用 & 连接
    const joined = plain.map((d) => d.value).join('&')
    const hasBinary = plain.some((d) => d.name === 'data-binary')
    const allTextish = plain.every((d) => d.name !== 'data-binary')
    const contentType = this.spec.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''

    if (/json/i.test(contentType) || (!contentType && allTextish && looksLikeJson(joined))) {
      this.spec.body.type = 'json'
      this.spec.body.json = joined
      return
    }
    if (!hasBinary && isFormUrlencoded(joined)) {
      this.spec.body.type = 'form'
      this.spec.body.form = splitFormPairs(joined)
      return
    }
    this.spec.body.type = 'raw'
    this.spec.body.raw = joined
  }
}

function emptyBody(): RequestBody {
  return { type: 'none', json: '', form: [], multipart: [], raw: '' }
}

/* ================================================================== */
/* 公共入口                                                            */
/* ================================================================== */

export function parseCurl(input: string): ParseResult {
  const trimmed = input.trim()
  if (trimmed === '') throw new CurlParseError('输入是空的', 0, '')

  const lex = tokenize(trimmed, { stopAtNewline: false })
  let tokens = lex.tokens

  // 命令边界 1：`;` `|` `&`
  const cut = lex.terminatorAt
  if (cut !== -1) tokens = tokens.filter((t) => t.end <= cut)

  // 命令起点必须先定位：否则 `TOKEN=x curl ...` 的前缀赋值会让下面把自家 curl 当成"第二条"
  const curlIdx = tokens.findIndex((t) => isCurlWord(t.value))
  if (curlIdx === -1) {
    throw new CurlParseError(
      '没找到 curl，输入至少要以 curl 开头',
      tokens[0]?.start ?? 0,
      tokens[0]?.value ?? ''
    )
  }

  // 命令边界 2：第一条之后的第二个 curl
  const relSecond = tokens.slice(curlIdx + 1).findIndex((t) => isCurlWord(t.value))
  const secondIdx = relSecond === -1 ? -1 : curlIdx + 1 + relSecond
  const boundary = secondIdx === -1 ? null : (tokens[secondIdx]?.start ?? null)
  if (secondIdx !== -1) tokens = tokens.slice(0, secondIdx)

  const asm = new Assembler()
  // 词法阶段的软问题（未闭合引号等）必须冒泡，否则用户看到"解析成功"但结果被截半
  for (const w of lex.warnings) asm.warn('malformed', w)
  for (let k = 0; k < curlIdx; k++) {
    const t = tokens[k] as Token
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value)) {
      asm.warn('malformed', `curl 之前的 "${t.value}" 不是环境赋值，已忽略`, t.start)
    }
  }

  const { args, urls } = expandArgs(tokens.slice(curlIdx + 1))
  asm.dispatch(args, urls)

  let result: ParseResult
  try {
    result = { spec: (asm.finalize(), asm.spec), warnings: asm.warnings }
  } catch (err) {
    if (err instanceof CurlParseError) {
      // 失败也带回已解析部分，符合 PLAN"报错但表单保留已解析部分"
      err.message = `${err.message}（已解析的部分仍可用）`
      asm.warnings.push({ code: 'malformed', message: err.message })
      result = { spec: asm.spec, warnings: asm.warnings }
    } else throw err
  }

  const restOffset = boundary ?? (cut !== -1 ? cut : -1)
  if (restOffset !== -1 && hasAnotherCurl(trimmed.slice(restOffset))) {
    result.warnings.push({
      code: 'multiple-commands',
      message: '输入里有多条 curl 命令，只解析了第一条',
      at: restOffset
    })
  }
  return result
}

/** 生成一个建议的请求名（供 UI 与历史列表用），基于 host + 首个路径段。 */
export function suggestName(spec: CurlSpec): string {
  const path = spec.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?]*/i, '')
  const seg = path.split('/').filter(Boolean).pop()
  if (seg) return decodeSafe(stripVars(seg))
  const host = /^https?:\/\/([^/?#]+)/i.exec(spec.url)?.[1]
  if (host) return host
  return '未命名请求'
}

function stripVars(text: string): string {
  return text.replace(/\{\{([^}]*)\}\}/g, '$1')
}

/* ================================================================== */
/* 工具函数（部分对外导出，供生成侧与安卓侧对齐参考）                   */
/* ================================================================== */

function isCurlWord(value: string): boolean {
  return /(^|[\\/])curl(\.exe)?$/i.test(value)
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)
}

function hasAnotherCurl(text: string): boolean {
  try {
    // 传进来的通常是 `; curl ...` 这种以运算符开头的残串；
    // 不剥掉前导运算符，分词器第一步就截断，tokens 为空 → 误判成"没有第二条命令"
    const body = text.replace(/^[;&|\s]+/, '')
    return tokenize(body, { stopAtNewline: false }).tokens.some((t) => isCurlWord(t.value))
  } catch {
    return false
  }
}

function secondsToMs(text: string): number {
  const num = Number.parseFloat(text)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.round(num * 1000)
}

/** 把 url 里的查询串拆进 query[]，url 只留基址（生成时再拼回去）。 */
function splitUrlQuery(spec: CurlSpec): void {
  const q = spec.url.indexOf('?')
  if (q === -1) return
  const qs = spec.url.slice(q + 1)
  spec.url = spec.url.slice(0, q)
  for (const p of splitFormPairs(qs)) {
    if (!spec.query.some((x) => x.key === p.key && x.value === p.value)) spec.query.push(p)
  }
}

export function parseMultipartArg(raw: string, textOnly = false): MultipartParam {
  const item: MultipartParam = { key: '', kind: 'text', value: '', enabled: true }
  const eq = raw.indexOf('=')
  if (eq === -1) {
    item.key = raw
    return item
  }
  item.key = raw.slice(0, eq)
  const rest = raw.slice(eq + 1)

  if (textOnly) {
    // --form-string 不解析 ;type= / ;filename=，分号属于值本身
    item.kind = 'text'
    item.value = rest
    return item
  }

  const parts = splitOutsideQuotes(rest, ';')
  const body = (parts[0] ?? '') as string
  for (const p of parts.slice(1)) {
    const kv = /^([A-Za-z]+)\s*=\s*([\s\S]*)$/i.exec(p.trim())
    if (!kv) continue
    const name = (kv[1] ?? '').toLowerCase()
    const val = (kv[2] ?? '') as string
    if (name === 'type') item.contentType = val
    else if (name === 'filename') item.filename = val
  }

  if (!textOnly && body.startsWith('@')) {
    item.kind = 'file'
    item.value = body.slice(1)
  } else if (!textOnly && body.startsWith('<')) {
    item.kind = 'file'
    item.value = body.slice(1)
    item.filename = item.filename ?? body.slice(1).split(/[\\/]/).pop()
  } else {
    item.kind = 'text'
    item.value = body
  }
  return item
}

/** 按 sep 拆分，但引号内的 sep 不生效（`-H 'a b'` 这类值不能被空格切坏）。 */
export function splitOutsideQuotes(text: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  for (const c of text) {
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      cur += c
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      cur += c
      continue
    }
    if (c === sep && !inSingle && !inDouble) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

export function splitFormPairs(text: string): Param[] {
  if (text === '') return []
  return text.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq === -1) return { key: decodeSafe(pair), value: '', enabled: true }
    return {
      key: decodeSafe(pair.slice(0, eq)),
      value: decodeSafe(pair.slice(eq + 1)),
      enabled: true
    }
  })
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

export function looksLikeJson(text: string): boolean {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/**
 * 整串是否**能无损**落到 form[]。
 *
 * 判定用自校验：decode 后再 encode，必须逐字符等于原文。
 * 因为生成方向会对 form 的 key/value 重新 percent-encode，而 curl 的 `-d` 不解码——
 * 若原文含未编码的空格、`@`、`+`、裸 `%`（例：`-d 'email=a@b.com'`），
 * 落进 form 再出去就变成 `email=a%40b.com`，实际发送的字节改了。
 * 这种宁可保持 raw 原文，也不悄悄改写用户的请求。
 */
export function isFormUrlencoded(text: string): boolean {
  if (text === '' || !text.includes('=')) return false
  const pairs = text.split('&')
  for (const pair of pairs) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    if (eq === -1 && !/^[\w.-]+$/.test(pair)) return false
  }
  const rebuilt = pairs
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return encodeKeepingVars(decodeSafe(pair))
      const k = encodeKeepingVars(decodeSafe(pair.slice(0, eq)))
      const v = encodeKeepingVars(decodeSafe(pair.slice(eq + 1)))
      return `${k}=${v}`
    })
    .join('&')
  return rebuilt === text
}

function tryBase64Decode(text: string): string | null {
  try {
    const bytes = base64ToBytes(text)
    if (bytes === null) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 自带 base64 解码，避免浏览器 / Node 的 atob 差异。 */
export function base64ToBytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s/g, '').replace(/=+$/, '')
  if (clean.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const idx = B64_ALPHABET.indexOf(ch)
    if (idx === -1) return null
    buffer = (buffer << 6) | idx
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0
    out += B64_ALPHABET[(b0 >> 2) & 0x3f]
    out += B64_ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3f] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}
