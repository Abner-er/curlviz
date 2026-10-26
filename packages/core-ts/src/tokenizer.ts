/**
 * bash 风格分词器（tokenizer）。
 *
 * 为什么不能 split(/\s+/)：curl 命令里的 `'"'"'`、`$'{"a":"b c"}'`、行尾 `\` 续行、
 * `#` 注释、`$(cmd)` 替换，随便一个都能把简单切分打碎。这一步错了，后面解析和
 * 生成全错，而且错误会以"生成的 curl 在终端跑不通"的形式暴露给用户，最难查。
 *
 * 语义对齐 bash，覆盖：
 *   - 单引号：内部一切字面量，`\` 不特殊
 *   - 双引号：`\$` `` \` `` `\"` `\\` 与 `\`+换行 续行生效，其余 `\x` 保留 `\`
 *   - ANSI-C 引用 `$'...'`：`\n \t \r \\ \" \' \xNN \uNNNN` 与八进制
 *   - 引号外 `\` 转义、`\`+换行 续行（容忍续行符后残留的空格，复制粘贴常见）
 *   - 词首 `#` 是注释，吃到行尾
 *   - `$VAR` `${VAR}` `$(cmd)` 反引号：不求值，原文保留 + 打 hasSubstitution 标记
 *   - 顶层 `;` `|` `||` `&` `&&` 与未转义换行 = 命令边界，在此截断
 */

export type QuoteKind = 'none' | 'single' | 'double' | 'ansi-c'

export interface Token {
  /** 引号已剥离、转义已处理后的字面文本；shell 替换部分保留原文。 */
  value: string
  /** 输入里的原始片段（含引号），用于 rawArgs 保真回吐。 */
  raw: string
  /** 词内出现过的最强引号类型，用于判断是否原本带引号。 */
  quote: QuoteKind
  start: number
  end: number
  /** 词内含 `$VAR` / `${}` / `$()` / 反引号 —— 上层据此发"不保证等价"警告。 */
  hasSubstitution: boolean
}

export interface TokenizeResult {
  tokens: Token[]
  /** 命中的命令边界字符（`;` `|` `&` 换行），无则为 null。 */
  terminator: string | null
  /** terminator 的偏移；无则为 -1。 */
  terminatorAt: number
  /** 未闭合引号之类的软问题，供上层转成 warning。 */
  warnings: string[]
}

const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/

const QUOTE_RANK: Record<QuoteKind, number> = { none: 0, single: 1, 'ansi-c': 2, double: 3 }

/** 词边界字符（只在引号外生效）。 */
function isOperator(c: string | undefined): boolean {
  return c === ';' || c === '|' || c === '&' || c === '(' || c === ')'
}

class Lexer {
  private readonly input: string
  private readonly n: number
  private readonly stopAtNewline: boolean
  private i = 0
  private readonly tokens: Token[] = []
  readonly warnings: string[] = []
  terminator: string | null = null
  terminatorAt = -1

  /** 当前正在累积的词；null 表示不在词中。 */
  private word: string[] | null = null
  private wordStart = 0
  private wordQuote: QuoteKind = 'none'
  private wordSub = false

  constructor(input: string, stopAtNewline: boolean) {
    this.input = input
    this.n = input.length
    this.stopAtNewline = stopAtNewline
  }

  private at(k: number): string | undefined {
    return k < this.n ? (this.input[k] as string) : undefined
  }

  private emit(text: string): void {
    if (this.word === null) this.openWord()
    this.word?.push(text)
  }

  private openWord(): void {
    this.word = []
    this.wordStart = this.i
    this.wordQuote = 'none'
    this.wordSub = false
  }

  private markSub(text: string): void {
    if (this.word === null) this.openWord()
    this.word?.push(text)
    this.wordSub = true
  }

  private useQuote(kind: QuoteKind): void {
    if (this.word === null) this.openWord()
    if (QUOTE_RANK[kind] > QUOTE_RANK[this.wordQuote]) this.wordQuote = kind
  }

  private closeWord(): void {
    if (this.word === null) return
    const value = this.word.join('')
    this.tokens.push({
      value,
      raw: this.input.slice(this.wordStart, this.i),
      quote: this.wordQuote,
      start: this.wordStart,
      end: this.i,
      hasSubstitution: this.wordSub
    })
    this.word = null
  }

  private inWord(): boolean {
    return this.word !== null
  }

  /** 续行符后允许残留空格/制表（粘贴常见），跳过它们。 */
  private skipInlineSpaces(from: number): number {
    let p = from
    while (p < this.n && (this.at(p) === ' ' || this.at(p) === '\t' || this.at(p) === '\r')) p++
    return p
  }

  /** 若 `\` 后是换行，吃掉整条续行；返回是否命中。 */
  private tryContinuation(): boolean {
    const nxt = this.at(this.i + 1)
    if (nxt === '\n') {
      this.i = this.skipInlineSpaces(this.i + 2)
      return true
    }
    if (nxt === '\r' && this.at(this.i + 2) === '\n') {
      this.i = this.skipInlineSpaces(this.i + 3)
      return true
    }
    return false
  }

  run(): TokenizeResult {
    while (this.i < this.n) {
      const c = this.at(this.i) as string

      if (c === ' ' || c === '\t' || c === '\r') {
        this.closeWord()
        this.i++
        continue
      }
      if (c === '\n') {
        this.closeWord()
        if (this.stopAtNewline) {
          this.terminator = '\n'
          this.terminatorAt = this.i
          break
        }
        this.i++
        continue
      }
      if (c === '#' && !this.inWord()) {
        // 词首的 # = 注释，吃到行尾
        const nl = this.input.indexOf('\n', this.i)
        this.i = nl === -1 ? this.n : nl
        continue
      }
      if (isOperator(c)) {
        // bash：即便紧贴词中（a;b），运算符也会结束当前词
        this.closeWord()
        const next = this.at(this.i + 1)
        this.terminator = c === '|' || c === '&' ? `${c}${next === c ? c : ''}` : c
        this.terminatorAt = this.i
        break
      }
      if (c === '\\' && !this.inWord() && this.tryContinuation()) continue
      if (c === '\\') {
        // 词内反斜杠
        if (this.tryContinuation()) continue
        const nxt = this.at(this.i + 1)
        if (nxt === undefined) {
          this.emit('\\')
          this.i++
          continue
        }
        this.emit(nxt)
        this.i += 2
        continue
      }
      if (c === "'") {
        this.useQuote('single')
        this.i++
        this.readSingle()
        continue
      }
      if (c === '"') {
        this.useQuote('double')
        this.i++
        this.readDouble()
        continue
      }
      if (c === '$' && this.at(this.i + 1) === "'") {
        this.useQuote('ansi-c')
        this.i += 2
        this.readAnsiC()
        continue
      }
      if (c === '$' && this.at(this.i + 1) === '(') {
        const start = this.i
        this.i += 2
        this.skipBalancedParens()
        this.markSub(this.input.slice(start, this.i))
        continue
      }
      if (c === '$' && this.at(this.i + 1) === '{') {
        const start = this.i
        const close = this.input.indexOf('}', this.i + 2)
        this.i = close === -1 ? this.n : close + 1
        this.markSub(this.input.slice(start, this.i))
        continue
      }
      if (c === '$' && (IDENT_START.test(this.at(this.i + 1) ?? '') || this.at(this.i + 1) === '?')) {
        const start = this.i
        this.i++
        while (IDENT_PART.test(this.at(this.i) ?? '')) this.i++
        this.markSub(this.input.slice(start, this.i))
        continue
      }
      if (c === '`') {
        const start = this.i
        this.i++
        const close = this.input.indexOf('`', this.i)
        this.i = close === -1 ? this.n : close + 1
        if (close === -1) this.warnings.push(`未闭合的反引号（位置 ${start}）`)
        this.markSub(this.input.slice(start, this.i))
        continue
      }

      this.emit(c)
      this.i++
    }
    this.closeWord()
    return {
      tokens: this.tokens,
      terminator: this.terminator,
      terminatorAt: this.terminatorAt,
      warnings: this.warnings
    }
  }

  /** 前提：i 已越过开引号。 */
  private readSingle(): void {
    const start = this.i
    const close = this.input.indexOf("'", this.i)
    if (close === -1) {
      this.emit(this.input.slice(start, this.n))
      this.i = this.n
      this.warnings.push(`未闭合的单引号（位置 ${start - 1}），已按到行尾处理`)
      return
    }
    this.emit(this.input.slice(start, close))
    this.i = close + 1
  }

  private readDouble(): void {
    while (this.i < this.n) {
      const c = this.at(this.i) as string

      if (c === '"') {
        this.i++
        return
      }
      if (c === '\\') {
        const nxt = this.at(this.i + 1)
        if (nxt === '\n') {
          this.i += 2
          continue
        }
        if (nxt === '\r' && this.at(this.i + 2) === '\n') {
          this.i += 3
          continue
        }
        if (nxt === undefined) {
          this.emit('\\')
          this.i++
          continue
        }
        if (nxt === '"' || nxt === '$' || nxt === '`' || nxt === '\\') {
          this.emit(nxt)
          this.i += 2
          continue
        }
        // bash：双引号内其它 \x 保留反斜杠
        this.emit('\\')
        this.emit(nxt)
        this.i += 2
        continue
      }
      if (c === '$') {
        if (this.at(this.i + 1) === '(') {
          const start = this.i
          this.i += 2
          this.skipBalancedParens()
          this.markSub(this.input.slice(start, this.i))
          continue
        }
        if (this.at(this.i + 1) === '{') {
          const start = this.i
          const close = this.input.indexOf('}', this.i + 2)
          this.i = close === -1 ? this.n : close + 1
          this.markSub(this.input.slice(start, this.i))
          continue
        }
        if (IDENT_START.test(this.at(this.i + 1) ?? '')) {
          const start = this.i
          this.i++
          while (IDENT_PART.test(this.at(this.i) ?? '')) this.i++
          this.markSub(this.input.slice(start, this.i))
          continue
        }
        this.emit(c)
        this.i++
        continue
      }
      if (c === '`') {
        const start = this.i
        this.i++
        const close = this.input.indexOf('`', this.i)
        this.i = close === -1 ? this.n : close + 1
        this.markSub(this.input.slice(start, this.i))
        continue
      }
      // 双引号内的换行是合法的词内字符，不截断
      this.emit(c)
      this.i++
    }
    this.warnings.push('未闭合的双引号，已按到行尾处理')
  }

  private readAnsiC(): void {
    while (this.i < this.n) {
      const c = this.at(this.i) as string
      if (c === "'") {
        this.i++
        return
      }
      if (c !== '\\') {
        this.emit(c)
        this.i++
        continue
      }
      const nxt = this.at(this.i + 1)
      this.i += 2
      switch (nxt) {
        case 'n':
          this.emit('\n')
          break
        case 't':
          this.emit('\t')
          break
        case 'r':
          this.emit('\r')
          break
        case 'b':
          this.emit('\b')
          break
        case 'f':
          this.emit('\f')
          break
        case 'v':
          this.emit('\v')
          break
        case 'a':
          this.emit('\u0007')
          break
        case 'e':
          this.emit('\u001b')
          break
        case '\\':
          this.emit('\\')
          break
        case "'":
          this.emit("'")
          break
        case '"':
          this.emit('"')
          break
        case 'x': {
          const hex = this.readHexRun(2)
          this.emit(hex === null ? 'x' : String.fromCharCode(parseInt(hex, 16)))
          break
        }
        case 'u': {
          const hex = this.readHexRun(4)
          this.emit(hex === null ? 'u' : String.fromCodePoint(parseInt(hex, 16)))
          break
        }
        case 'U': {
          const hex = this.readHexRun(8)
          this.emit(hex === null ? 'U' : String.fromCodePoint(parseInt(hex, 16)))
          break
        }
        case undefined:
          break
        default: {
          if (/[0-7]/.test(nxt)) {
            let oct = nxt
            while (oct.length < 3 && /[0-7]/.test(this.at(this.i) ?? '')) {
              oct += this.at(this.i) as string
              this.i++
            }
            this.emit(String.fromCharCode(parseInt(oct, 8)))
          } else {
            this.emit(nxt)
          }
        }
      }
    }
    this.warnings.push("未闭合的 $' 引用，已按到行尾处理")
  }

  private readHexRun(len: number): string | null {
    let out = ''
    while (out.length < len && /[0-9a-fA-F]/.test(this.at(this.i) ?? '')) {
      out += this.at(this.i) as string
      this.i++
    }
    return out.length === 0 ? null : out
  }

  /** `$(` 之后跳到匹配的 `)`，尊重内部嵌套引号与括号。 */
  private skipBalancedParens(): void {
    let depth = 1
    while (this.i < this.n && depth > 0) {
      const c = this.at(this.i) as string
      if (c === "'") {
        const close = this.input.indexOf("'", this.i + 1)
        this.i = close === -1 ? this.n : close + 1
        continue
      }
      if (c === '"') {
        this.i++
        while (this.i < this.n && this.at(this.i) !== '"') {
          if (this.at(this.i) === '\\') this.i++
          this.i++
        }
        this.i++
        continue
      }
      if (c === '`') {
        const close = this.input.indexOf('`', this.i + 1)
        this.i = close === -1 ? this.n : close + 1
        continue
      }
      if (c === '(') depth++
      else if (c === ')') depth--
      this.i++
    }
  }
}

/**
 * 把一条命令串切成 token 序列。
 * 默认在未转义换行 / `;` / `|` / `&` 处截断，只返回第一条命令的 token，
 * 上层可据 terminatorAt 继续找下一条（并发出 multiple-commands 警告）。
 */
export function tokenize(input: string, opts?: { stopAtNewline?: boolean }): TokenizeResult {
  return new Lexer(input, opts?.stopAtNewline ?? true).run()
}

/** 只做词法切分，允许换行跨行（用于已知是单条命令的片段）。 */
export function tokenizeWords(input: string): Token[] {
  return new Lexer(input, false).run().tokens
}
