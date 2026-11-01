import type { CurlSpec, ParseWarning, QuoteStyle } from '@curlviz/core'

/** 响应体在界面上的归类决定用哪种渲染。 */
export type ResponseKind = 'json' | 'html' | 'xml' | 'text' | 'image' | 'pdf' | 'binary'

export interface SentResponse {
  status: number
  statusText: string
  ok: boolean
  /** 响应头。跨域时浏览器只暴露 CORS 安全清单里的那几个，读不到全部——见 hint。 */
  headers: Param2[]
  contentType: string
  /** 截断后真正展示用的字节。 */
  bytes: Uint8Array
  /** 服务端实际发出的总字节数（Content-Length 或读到的长度取大者）。 */
  totalBytes: number
  /** totalBytes 是否准确；false 表示没 Content-Length 且超上限断流，只能给"至少这么多"。 */
  sizeExact: boolean
  truncated: boolean
  text: string
  kind: ResponseKind
  /** 从发起到拿到响应头 / 读完体的耗时。 */
  ttfbMs: number
  totalMs: number
}

/** 元组形式，避免和 core 的 Param（带 enabled）混用。 */
export interface Param2 {
  name: string
  value: string
}

export type FailureKind =
  /** fetch 抛 TypeError：CORS 被拦 / 服务不通 / 混合内容被浏览器禁。三者现场无法区分。 */
  | 'blocked-or-network'
  | 'timeout'
  | 'abort'
  | 'mixed-content'
  /** 浏览器做不到、必须走本地 agent 或终端的形态（如 multipart 里的文件字段）。 */
  | 'unsupported-in-browser'
  /**
   * 工具自己出错了（sendSpec 按设计不抛，真抛了就是连 fetch 都拿不到这类环境级故障）。
   * 单独立一类是为了不冒充网络问题：blocked-or-network 说的是"这条请求没出去"，
   * 而这里是"这个页面本身不对劲"，用户下一步该刷新页面而不是去查 CORS 头。
   */
  | 'tool-error'
  /** agent 路径：SSRF / allowlist / 缺 token / Origin 不符，被执行机拒绝。 */
  | 'agent-rejected'
  /** agent 路径：agent 自身 500 / 返回体不合契约 / curl 起不来。 */
  | 'agent-error'
  /** agent 路径：连不上执行机 agent（DNS、TCP、TLS、反代）。 */
  | 'unreachable'

export interface SendFailure {
  kind: FailureKind
  /** 给用户看的一句话，不编造原因。 */
  message: string
  /** 下一步怎么办。 */
  hint: string
  /** 原始错误文本，折叠在详情里，方便排查。 */
  raw?: string
}

export type SendOutcome = { ok: true; response: SentResponse } | { ok: false; failure: SendFailure }

/** 一次发送的完整结果：响应 + 发送期间发现的问题。 */
export interface SendReport {
  outcome: SendOutcome
  /** 命令里没被环境变量替换掉的 {{变量}}。 */
  unresolved: string[]
  /** 浏览器禁止脚本设置、因此这次没发出去的头名。 */
  blockedHeaders: string[]
  /** 这次发送里"浏览器语义与 curl 不一致"的逐条说明，界面如实展示，不粉饰。 */
  notes: string[]
  /** 实际发出去的 curl（变量已替换），用于"复制到终端"。 */
  curl: string
  sentAt: number
}

/** 一台执行机（ECS 上的 agent）。token 只存会话内存（决策②），不进 localStorage。 */
export interface AgentExecutor {
  id: string
  name: string
  /** agent 根地址，如 https://ecs-1.internal；发送时拼 /exec。 */
  baseUrl: string
  token: string
}

/** 发送走浏览器 fetch，还是某台执行机上的真 curl（M4 远程执行）。 */
export type TransportSelector =
  | { kind: 'browser' }
  | { kind: 'agent'; executor: AgentExecutor }

export interface Settings {
  quoteStyle: QuoteStyle
  multiline: boolean
  /** 历史与导出默认脱敏 Authorization / Cookie。 */
  redactHistory: boolean
  /** 「等价 curl」这块展开还是折成一条。长命令比响应区还占地方，所以给折叠，但状态要记住。 */
  curlOpen: boolean
  /** 工作台 : 结果 的宽度比例（0.28~0.78）。拖完松手才写，见 hooks/useSplit。 */
  splitRatio: number
}

export interface HistoryEntry {
  id: string
  /** 发起时间，Date.now()。 */
  at: number
  spec: CurlSpec
  /** 这份 spec 是否已被脱敏；存过脱敏版就无法还原。 */
  redacted: boolean
  /** 上次发送的结果摘要（没有就没发过）。 */
  result?: { status: number; ok: boolean; ms: number } | { error: string }
}

export interface DraftState {
  spec: CurlSpec
  warnings: ParseWarning[]
}
