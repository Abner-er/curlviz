/**
 * CurlSpec -> 结构化的 curl argv。
 *
 * 用于 M4 远程执行：agent 拿到 spec 后不拼 shell 字符串（注入面），
 * 直接 `spawn('curl', argv, { shell: false })`，凭据走 `--config -` 的 stdin 不进 `ps`。
 *
 * 为什么复用 `generateCurl` + `tokenizeWords` 而不是重写一份 flag 表：
 *   1) 顺序、`-X` 何时省略、multipart 何时改 `--form-string`、`--url-query` 独立成条、
 *      `resolve` 位置等 20 多条判据都已在 generate.ts 钉死并有 canonical 测试；
 *      重写一份迟早会漂。
 *   2) posix 引号策略把所有值单引号包住，bash 边界字符（`;` `|` `&`）都在引号内，
 *      tokenizeWords 不会被它们截断；tokenize 剥引号后逐 token 交给 spawn，
 *      argv 逐 token 等于「复制到终端」那条在 bash 下传给 curl 的词表。这是最硬的保证。
 *   3) rawArgs 存的是 bash 引号原文（§10.1 #1），tokenize 恰好剥掉这层引号拿到干净的 argv，
 *      复用 generateCurl 反而是解 rawArgs 引号的正道，不是绕路。
 *
 * 契约：本节实现 spec/README.md §13.2；调用方必须传入**已替换变量**的 spec
 * （web 侧发送前跑 `resolveSpec`，agent 侧收到也再校验一次）。
 */

import type { CurlSpec, Param } from './types'
import { generateCurl } from './generate'
import { tokenizeWords } from './tokenizer'

export interface AgentArgv {
  /** 交给 `spawn('curl', argv)` 的 argv（不含前导 `curl`）。 */
  argv: string[]
  /**
   * `--config -` 的 stdin 文本。凭据行按 curl 配置语法 `name = "value"` 拼好，
   * 空串表示没有凭据要转 stdin（此时 argv 里不会出现 `--config`）。
   */
  stdinConfig: string
}

/** 值里出现这些 key 的头一律转 stdin；argv 里不留明文。 */
const SENSITIVE_HEADER_RE = /^(authorization|cookie|proxy-authorization)$/i

/**
 * curl 配置文件里 `%NAME` 会做环境变量替换，`"` / `\` 是转义引导。
 * 三个字符要各自处理：`\`→`\\`、`"`→`\"`、`%`→`%%`。
 * 其它字符（含换行、控制符）curl 不特殊对待，原样即可。
 */
function escapeConfigValue(value: string): string {
  let out = ''
  for (const c of value) {
    if (c === '\\') out += '\\\\'
    else if (c === '"') out += '\\"'
    else if (c === '%') out += '%%'
    else out += c
  }
  return out
}

function noneAuth(): CurlSpec['auth'] {
  return { type: 'none', basic: { username: '', password: '' }, bearer: { token: '' } }
}

/**
 * 从 `http://user:pass@host:port` 形态的 proxy 里剥出凭据。
 * 无凭据形态（`http://host` / `socks5://host:1080`）返回 null，让 proxy 原样进 argv。
 */
function splitProxyCreds(proxy: string): { clean: string; creds: string } | null {
  const m = /^(https?:\/\/)([^/?#@]+)@([^/?#]+)(.*)$/i.exec(proxy)
  if (!m) return null
  return { clean: `${m[1] ?? ''}${m[3] ?? ''}${m[4] ?? ''}`, creds: m[2] ?? '' }
}

/**
 * 主入口。返回的 argv 保证：
 *   - 不含前导 `curl`，可直接 `spawn('curl', argv, { shell: false })`；
 *   - basic-auth / bearer / Cookie 类头 / proxy 用户名密码**不出现在 argv**，
 *     改走 stdinConfig（curl 配置语法），由 agent 端写进 `--config -` 的管道；
 *   - 若 stdinConfig 非空，argv 头部会自动带 `--config -` 两项，agent 直接喂 stdin 即可。
 *
 * 不做的事：
 *   - 不做 SSRF 检查（那是 M4c agent 端 allowlist 的事，判据要读运维配的白名单）；
 *   - 不做变量替换（调用方先跑 `resolveSpec`，spec 里不许留 `{{}}`）；
 *   - 不改方法语义（generateCurl 的 `-X`/`-I`/隐式 POST 规则照单全收）。
 */
export function buildArgv(spec: CurlSpec): AgentArgv {
  const configLines: string[] = []
  const redacted: CurlSpec = JSON.parse(JSON.stringify(spec))

  if (redacted.auth.type === 'basic') {
    const b = redacted.auth.basic
    if (b.username !== '' || b.password !== '') {
      configLines.push(`user = "${escapeConfigValue(`${b.username}:${b.password}`)}"`)
    }
    redacted.auth = noneAuth()
  } else if (redacted.auth.type === 'bearer') {
    const t = redacted.auth.bearer.token
    if (t !== '') {
      configLines.push(`header = "Authorization: Bearer ${escapeConfigValue(t)}"`)
    }
    redacted.auth = noneAuth()
  }

  const keptHeaders: Param[] = []
  for (const h of redacted.headers) {
    if (SENSITIVE_HEADER_RE.test(h.key)) {
      if (h.enabled && h.value !== '') {
        configLines.push(`header = "${escapeConfigValue(`${h.key}: ${h.value}`)}"`)
      }
      continue
    }
    keptHeaders.push(h)
  }
  redacted.headers = keptHeaders

  if (redacted.options.proxy !== '') {
    const split = splitProxyCreds(redacted.options.proxy)
    if (split) {
      configLines.push(`proxy-user = "${escapeConfigValue(split.creds)}"`)
      redacted.options.proxy = split.clean
    }
  }

  const command = generateCurl(redacted, { multiline: false, quoteStyle: 'posix' })
  let argv = tokenizeWords(command).map((t) => t.value)
  if (argv[0] === 'curl') argv = argv.slice(1)
  if (configLines.length > 0) argv = ['--config', '-', ...argv]

  return { argv, stdinConfig: configLines.map((l) => `${l}\n`).join('') }
}
