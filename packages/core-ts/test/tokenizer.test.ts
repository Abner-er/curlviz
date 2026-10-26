/**
 * 词法层单测：只验 tokenizer 自己的语义，不牵涉 curl 含义。
 * 续行 / 注释 / 三套引号 / 转义 / 命令边界 / shell 替换，逐个钉死。
 */

import { describe, expect, it } from 'vitest'
import { tokenize, tokenizeWords } from '../src/tokenizer'

const values = (input: string): string[] => tokenizeWords(input).map((t) => t.value)

describe('基础切分', () => {
  it('空白与制表都是词边界', () => {
    expect(values('curl\t-a  b   c')).toEqual(['curl', '-a', 'b', 'c'])
  })

  it('空输入得到空数组', () => {
    expect(values('')).toEqual([])
    expect(values('   \n  ')).toEqual([])
  })

  it('token 带 raw 与起止偏移（rawArgs 保真回吐靠这个）', () => {
    const tokens = tokenizeWords("curl 'https://x/y'")
    const url = tokens[1]
    expect(url?.raw).toBe("'https://x/y'")
    expect(url?.value).toBe('https://x/y')
    expect(url?.start).toBe(5)
    expect(url?.quote).toBe('single')
  })
})

describe('引号', () => {
  it('单引号内一切字面量，反斜杠不特殊', () => {
    expect(values("'a\\b'")).toEqual(['a\\b'])
    expect(values("'$VAR'")).toEqual(['$VAR'])
  })

  it('单引号内换行不截断词', () => {
    expect(values("'a\nb'")).toEqual(['a\nb'])
  })

  it('双引号只认 $ ` " \\ 四种转义，其余保留反斜杠', () => {
    expect(values('"a\\"b"')).toEqual(['a"b'])
    expect(values('"a\\\\b"')).toEqual(['a\\b'])
    expect(values('"a\\nb"')).toEqual(['a\\nb'])
    expect(values('"a\\tb"')).toEqual(['a\\tb'])
  })

  it('双引号内 $VAR 被标记为替换但保留原文', () => {
    const tokens = tokenizeWords('"a$VARb"')
    expect(tokens[0]?.value).toBe('a$VARb')
    expect(tokens[0]?.hasSubstitution).toBe(true)
  })

  it('引号类型取词内最强者（连续引号拼接收法判成 double）', () => {
    const tokens = tokenizeWords(`'it'"'"'s ok'`)
    expect(tokens[0]?.value).toBe("it's ok")
    expect(tokens[0]?.quote).toBe('double')
  })

  it('双引号内的单引号无需转义', () => {
    expect(values(`"it's"`)).toEqual(["it's"])
  })

  it('空引号产生空 token（curl 传空头/空 body 的合法形态）', () => {
    expect(values(`x '' y`)).toEqual(['x', '', 'y'])
  })
})

describe("ANSI-C 引用 $'...'", () => {
  it('常见转义逐条展开', () => {
    expect(values("$'a\\nb'")).toEqual(['a\nb'])
    expect(values("$'a\\tb'")).toEqual(['a\tb'])
    expect(values("$'\\\\'")).toEqual(['\\'])
    expect(values("$'\\''")).toEqual(["'"])
    expect(values("$'a\\rb'")).toEqual(['a\rb'])
  })

  it('hex 与 unicode 转义', () => {
    expect(values("$'\\x41'")).toEqual(['A'])
    expect(values("$'\\u4e2d'")).toEqual(['中'])
  })

  it('八进制转义', () => {
    expect(values("$'\\101'")).toEqual(['A'])
  })

  it('未知转义丢反斜杠（与 bash 一致）', () => {
    expect(values("$'\\z'")).toEqual(['z'])
  })

  it('未闭合只报警不抛异常', () => {
    const r = tokenize("$'oops", { stopAtNewline: false })
    expect(r.tokens[0]?.value).toBe('oops')
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe('续行', () => {
  it('反斜杠 + 换行 = 续行，不产生词边界', () => {
    expect(values("curl -L \\\n  -k")).toEqual(['curl', '-L', '-k'])
  })

  it('续行换行后残留的空格/制表也吃掉', () => {
    expect(values("curl -L \\\n \t -k")).toEqual(['curl', '-L', '-k'])
  })

  it('反斜杠后直接跟空格不是续行（bash 里转义的是那个空格本身）', () => {
    expect(values("curl -L\\ \n-k")).toEqual(['curl', '-L ', '-k'])
  })

  it('CRLF 换行同样算续行', () => {
    expect(values("curl 'a' \\\r\n  -L")).toEqual(['curl', 'a', '-L'])
  })

  it('紧贴词尾的反斜杠续行会把前后拼成一个词（bash 真实语义，不是我们的发明）', () => {
    // bash: echo 'a'\
    // b   →  ab
    expect(values("'a'\\\nb")).toEqual(['ab'])
  })

  it('双引号内的反斜杠 + 换行只删换行，不引入新字符', () => {
    expect(values('"a\\\nb"')).toEqual(['ab'])
  })

  it('词内裸反斜杠转义下一个字符', () => {
    expect(values("a\\ b")).toEqual(['a b'])
    expect(values("a\\-b")).toEqual(['a-b'])
  })

  it('行尾孤立反斜杠当字面量', () => {
    expect(values("a\\")).toEqual(['a\\'])
  })
})

describe('注释与命令边界', () => {
  it('词首 # 吃到行尾，词内 # 不算', () => {
    expect(values("a # c\nb")).toEqual(['a', 'b'])
    expect(values('a#b')).toEqual(['a#b'])
    expect(values("'#not-comment'")).toEqual(['#not-comment'])
  })

  it('stopAtNewline（默认）在未转义换行处截断', () => {
    const r = tokenize("curl a\ncurl b")
    expect(r.tokens.map((t) => t.value)).toEqual(['curl', 'a'])
    expect(r.terminator).toBe('\n')
  })

  it('stopAtNewline:false 时换行只当空白（多行续行命令走这条路）', () => {
    const r = tokenize("curl a\n  -L", { stopAtNewline: false })
    expect(r.tokens.map((t) => t.value)).toEqual(['curl', 'a', '-L'])
    expect(r.terminator).toBeNull()
  })

  for (const op of [';', '|', '&', '&&', '||']) {
    it(`引号外的 ${op} 是命令边界`, () => {
      const r = tokenize(`curl a ${op} curl b`, { stopAtNewline: false })
      expect(r.tokens.map((t) => t.value)).toEqual(['curl', 'a'])
      expect(r.terminator).toBe(op)
    })
  }

  it('引号内的 ; | & 不算边界', () => {
    const r = tokenize("curl 'a;b|c&d'", { stopAtNewline: false })
    expect(r.tokens.map((t) => t.value)).toEqual(['curl', 'a;b|c&d'])
    expect(r.terminator).toBeNull()
  })

  it('terminatorAt 让上层能找回剩余文本', () => {
    const input = 'curl a; curl b'
    const r = tokenize(input, { stopAtNewline: false })
    expect(input.slice(r.terminatorAt ?? -1)).toBe('; curl b')
  })
})

describe('shell 替换（不求值，只标记）', () => {
  it('$VAR / ${VAR} / $(cmd) / 反引号都保留原文并打标记', () => {
    const tokens = tokenizeWords('$HOME ${X} $(date) `id`')
    expect(tokens.map((t) => t.value)).toEqual(['$HOME', '${X}', '$(date)', '`id`'])
    expect(tokens.every((t) => t.hasSubstitution)).toBe(true)
  })

  it('$() 内部嵌套括号与引号都能配对', () => {
    const tokens = tokenizeWords('a$(echo "b (c) d")e')
    expect(tokens[0]?.value).toBe('a$(echo "b (c) d")e')
    expect(tokens[0]?.hasSubstitution).toBe(true)
  })

  it('裸 $ 结尾不算替换；a$b 里的 $b 算（bash 会展开变量 b）', () => {
    const sub = tokenizeWords('a$b')
    expect(sub[0]?.value).toBe('a$b')
    expect(sub[0]?.hasSubstitution).toBe(true)
    const lone = tokenizeWords('100$')
    expect(lone[0]?.value).toBe('100$')
    expect(lone[0]?.hasSubstitution).toBe(false)
  })

  it('单引号里的 $ 不参与（那是字面量）', () => {
    const tokens = tokenizeWords("'$HOME'")
    expect(tokens[0]?.hasSubstitution).toBe(false)
  })

  it('未闭合反引号给软警告', () => {
    const r = tokenize('a `unclosed', { stopAtNewline: false })
    expect(r.warnings.some((w) => w.includes('反引号'))).toBe(true)
  })
})
