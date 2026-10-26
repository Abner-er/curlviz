/**
 * CurlSpec v1 —— 双端（TS / Kotlin）唯一事实源的类型定义。
 *
 * 契约正文见 docs/PLAN.md 第 3 节。改这里的字段必须同步：
 *   1) docs/PLAN.md 的 JSON 示例
 *   2) spec/fixtures/*.json（两端共用的契约用例）
 *   3) android 侧的 Kotlin data class
 *
 * 本文件刻意不依赖任何浏览器 / Node API，保证可被两端复用。
 */

/** 契约版本，用于集合文件与历史数据的向前兼容判断。 */
export const CURLSPEC_VERSION = 1

export type BodyType = 'none' | 'json' | 'form' | 'multipart' | 'raw'
export type AuthType = 'none' | 'basic' | 'bearer'

/** 已知的 HTTP 方法（仅用于 UI 下拉建议；解析器允许任意字符串，curl 本身不限）。 */
export const KNOWN_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS'
] as const

export type HttpMethod = (typeof KNOWN_METHODS)[number] | (string & {})

/**
 * 键值对 —— query 参数与 header 共用。
 * `enabled=false` 表示"表单里填着但本次不发送"，生成 curl 时整条跳过。
 */
export interface Param {
  key: string
  value: string
  enabled: boolean
}

/** multipart 表单项：text 走 `-F 'k=v'`，file 走 `-F 'k=@path;type=...'`。 */
export interface MultipartParam {
  key: string
  kind: 'text' | 'file'
  /** kind=text 时为字段值；kind=file 时为文件路径。 */
  value: string
  /** kind=file 时可选的 `;filename=` 覆盖名。 */
  filename?: string
  /** `;type=` 内容类型。 */
  contentType?: string
  enabled: boolean
}

export interface RequestBody {
  type: BodyType
  json: string
  form: Param[]
  multipart: MultipartParam[]
  raw: string
}

export interface AuthConfig {
  type: AuthType
  basic: { username: string; password: string }
  bearer: { token: string }
}

export interface RequestOptions {
  /** `-L` */
  followRedirects: boolean
  /** `-k` */
  insecure: boolean
  /** `--compressed` */
  compressed: boolean
  /** 总耗时上限，对应 `-m/--max-time`；也是 fetch 侧 AbortController 的超时。0=不限。 */
  timeoutMs: number
  /** 连接阶段上限，对应 `--connect-timeout`。0=不输出。 */
  connectTimeoutMs: number
  /** `-A` */
  userAgent: string
  /** `-x` */
  proxy: string
}

/** 解析后无法映射到 CurlSpec 的原始 token 片段 —— 逃生通道，保证往返不丢数据。 */
export type RawArg = string

export interface CurlSpec {
  version: number
  name: string
  method: HttpMethod
  url: string
  query: Param[]
  headers: Param[]
  body: RequestBody
  auth: AuthConfig
  options: RequestOptions
  rawArgs: RawArg[]
}

/* ------------------------------------------------------------------ */
/* 解析结果                                                            */
/* ------------------------------------------------------------------ */

export type WarningCode =
  /** 命令里出现 `$VAR` / `${VAR}` / 反引号，无法求值，已原样保留。 */
  | 'shell-substitution'
  /** curl 命令后面还有别的 curl（管道/链式），只解析了第一条。 */
  | 'multiple-commands'
  /** 出现了未识别的 flag，已进 rawArgs。 */
  | 'unknown-flag'
  /** 出现了多个 URL 位置参数（curl 会依次请求多个 URL），仅第一个进 url。 */
  | 'extra-url'
  /** `--data-urlencode` 的 @file / 裸内容形态，无法无损映射到 form[]。 */
  | 'data-urlencode-lossy'
  /** 结构不完整但已尽力解析（例如 flag 缺参数）。 */
  | 'malformed'
  /** 两个 flag 都认识但语义冲突，按优先级取其一，另一个原样保留（如 -I 与 -X GET）。 */
  | 'flag-conflict'

export interface ParseWarning {
  code: WarningCode
  message: string
  /** 出问题的 token 在原始命令串中的起始偏移，供 UI 高亮。 */
  at?: number
}

export interface ParseResult {
  spec: CurlSpec
  warnings: ParseWarning[]
}

/** 解析彻底失败（连 URL 都没拿到）时抛出，带 token 位置。 */
export class CurlParseError extends Error {
  readonly at: number
  readonly token: string
  constructor(message: string, at: number, token: string) {
    super(message)
    this.name = 'CurlParseError'
    this.at = at
    this.token = token
  }
}

/* ------------------------------------------------------------------ */
/* 生成选项                                                            */
/* ------------------------------------------------------------------ */

/**
 * 引号风格。
 * - posix:   单引号包裹，内部 `'` → `'\''`（bash / git-bash / WSL / macOS / Linux）
 * - windows: 双引号包裹，内部 `"` → `\"`（cmd.exe / PowerShell 里单引号技巧不成立）
 *
 * 注意：POSIX 的 `'\''` 是 shell 语法，在 cmd.exe 中原样传给 curl 会被当字面量，
 * 所以 Windows 用户必须切 windows 风格，否则带引号的 header/JSON 会坏。
 */
export type QuoteStyle = 'posix' | 'windows'

export interface GenerateOptions {
  /** true=多行反斜杠续行（默认，可读、可 diff），false=单行。 */
  multiline?: boolean
  quoteStyle?: QuoteStyle
  /** 多行时每行的缩进，默认两个空格。 */
  indent?: string
  /** 是否把 query[] 拼进 url 后再输出（默认 true）。 */
  mergeQueryIntoUrl?: boolean
  /** 是否输出 `# name` 注释行，默认 false。 */
  withNameComment?: boolean
}

/* ------------------------------------------------------------------ */
/* 环境变量 / 集合                                                     */
/* ------------------------------------------------------------------ */

export interface Environment {
  name: string
  variables: Param[]
}

export interface Collection {
  format: 'curlviz-collection'
  version: number
  environments: Environment[]
  requests: CurlSpec[]
}

export const COLLECTION_FORMAT = 'curlviz-collection'

/* ------------------------------------------------------------------ */
/* 工厂函数                                                            */
/* ------------------------------------------------------------------ */

export function createDefaultBody(type: BodyType = 'none'): RequestBody {
  return { type, json: '', form: [], multipart: [], raw: '' }
}

export function createDefaultAuth(): AuthConfig {
  return { type: 'none', basic: { username: '', password: '' }, bearer: { token: '' } }
}

export function createDefaultOptions(): RequestOptions {
  return {
    followRedirects: true,
    insecure: false,
    compressed: true,
    timeoutMs: 10000,
    connectTimeoutMs: 0,
    userAgent: '',
    proxy: ''
  }
}

export function createDefaultSpec(name = '未命名请求'): CurlSpec {
  return {
    version: CURLSPEC_VERSION,
    name,
    method: 'GET',
    url: '',
    query: [],
    headers: [],
    body: createDefaultBody(),
    auth: createDefaultAuth(),
    options: createDefaultOptions(),
    rawArgs: []
  }
}

/**
 * 解析专用的空基线。
 *
 * 与 createDefaultSpec 的分工很重要：
 *   - createDefaultSpec：用户在 UI 里"新建请求"，给的是友好默认（-L、--compressed、10s 超时）。
 *   - createParseDefaultSpec：从 curl 命令反推，一切未出现的开关都必须等于 curl 的原生行为
 *     （不跟随重定向、不压缩、不限时）。
 * 如果解析也套用友好默认，导入 `curl https://x` 再生成就会凭空多出 `-L --compressed -m 10`，
 * 等于悄悄改了用户命令的语义 —— 这是"复制到终端能跑"承诺的头号破坏者。
 */
export function createParseDefaultSpec(): CurlSpec {
  const spec = createDefaultSpec('')
  spec.options = {
    followRedirects: false,
    insecure: false,
    compressed: false,
    timeoutMs: 0,
    connectTimeoutMs: 0,
    userAgent: '',
    proxy: ''
  }
  return spec
}

/** 深拷贝，UI 态与发送态之间来回倒腾时避免共享引用。 */
export function cloneSpec(spec: CurlSpec): CurlSpec {
  return JSON.parse(JSON.stringify(spec)) as CurlSpec
}
