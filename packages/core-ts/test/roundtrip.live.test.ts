/**
 * 真实 curl 对拍（live 测试，默认跳过）。
 *
 * 为什么要有这个文件：`spec/fixtures` 钉的是"我们的 parse 与 generate 自洽"，
 * 但**真正的验收标准是 curl 本身**——"复制到终端能跑，跑出来的请求和粘进来时一样"。
 * 自洽的解析器完全可以和 curl 一致地错。所以这里用本机真 curl 做裁判。
 *
 * 做法：
 *   1. 进程内起两个 HTTP 靶子（8080 回显 / 8081 重定向与文件），把收到的
 *      请求行 + 原始头（`rawHeaders`，保留大小写与重复项）+ body 原样回吐；
 *   2. 每条用例跑**原命令**拿基线，再跑 parse→generate 的重新生成版，比较两次收到的 wire；
 *   3. 再生成一份 `quoteStyle: 'windows'` 的单行命令，用 `cmd /d /v:off /c`（verbatim 参数）
 *      跑一遍——这是实测唯一与"手工粘进 cmd.exe"逐字节一致的方式。
 *      两条生成命令都比同一条基线：bash 里跑**原命令**收到的线上字节。
 *      posix 列验"POSIX 终端粘贴"，cmd 列验"cmd.exe 粘贴"——后者是 Windows 运维每天踩的坑。
 *
 * 默认跳过：要占端口、要 spawn 真 curl，不该拖慢 `npm run verify`。
 * 跑法：`npx vitest run --workspace @curlviz/core` 时带环境变量 `CURLVIZ_LIVE=1`，
 * 或在核心包里 `CURLVIZ_LIVE=1 npx vitest run test/roundtrip.live.test.ts`。
 *
 * 判定：默认每条必须是 `same`；确认无法/不该一致的，必须在这里写明理由（KNOWN），
 * 空口"已知差异"不算。新增 KNOWN 时同步 `docs/PLAN.md` 附录 A。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateCurl, parseCurl } from '../src/index'

const execFileAsync = promisify(execFile)

const LIVE = process.env['CURLVIZ_LIVE'] === '1'
const ECHO_PORT = Number(process.env['CURLVIZ_RT_PORT'] ?? 8080)
const AUX_PORT = ECHO_PORT + 1

/** 固定 Date，否则两次运行差一秒就会被判成 diff。 */
const FIXED_DATE = 'Wed, 01 Jan 2025 00:00:00 GMT'

/** 两侧真实 curl 的指纹，写进报告，免得对拍结论脱离环境。 */
let bashMeta = ''
let cmdMeta = ''

/* ------------------------------------------------------------------ */
/* 靶子服务器                                                          */
/* ------------------------------------------------------------------ */

/** 把收到的请求原样 dump 成文本；这就是"线上字节"，也是比较的对象。 */
function dumpRequest(req: import('node:http').IncomingMessage, body: Buffer): string {
  const lines: string[] = [`REQ ${req.method} ${req.url ?? '/'}`]
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    lines.push(`HDR ${(raw[i] as string).toLowerCase()}: ${raw[i + 1] as string}`)
  }
  lines.push(`BODYLEN ${body.length}`)
  lines.push('BODY<<<')
  lines.push(body.toString('utf8'))
  lines.push('>>>BODY')
  return lines.join('\n')
}

function startTarget(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      const dump = dumpRequest(req, body)
      const reply = (
        status: number,
        extra: Record<string, string>,
        tail: string
      ): void => {
        res.writeHead(status, {
          // 头名统一小写：curl 发来的大小写两边一致，但 Node 会原样回显我们写的
          Date: FIXED_DATE,
          'Content-Type': 'text/plain; charset=utf-8',
          Connection: 'close',
          ...extra
        })
        res.end(tail)
      }

      if (path === '/hex.txt') return reply(200, {}, '0123456789abcdef')
      if (path === '/docs') return reply(301, { Location: '/docs-final' }, `MOVED\n${dump}`)
      if (path === '/archive') {
        return reply(301, { Location: `http://127.0.0.1:${AUX_PORT}/archive-final` }, `MOVED\n${dump}`)
      }
      const manual = /^\/manual(\d+)$/.exec(path)
      if (manual !== null) {
        const n = Number(manual[1])
        return reply(302, { Location: `/manual${n + 1}` }, `STEP ${n}\n${dump}`)
      }
      if (path === '/setcookie') {
        return reply(200, { 'Set-Cookie': 'sid=abc; Path=/' }, dump)
      }
      return reply(200, {}, dump)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 不指定 host ⇒ Node 绑 '::'（双栈），同时吃 ::1 / 127.0.0.1 / 127.0.0.2
    server.listen(port, () => resolve(server))
  })
}

/* ------------------------------------------------------------------ */
/* 命令执行器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 命令执行器。
 *
 * **必须异步**：靶子服务器就跑在本进程的同一个事件循环里，`spawnSync` 会把循环占死，
 * 服务器无法应答，每条 curl 都挂到超时（本机实测：34 条全 ETIMEDOUT）。
 * 这是这个文件踩过最贵的一坑，别再改回同步。
 */
interface Run {
  code: number
  wire: string
}

const RUN_TIMEOUT_MS = 8000

/** 需要落盘的用例（cookie jar 等）写到这里，跑完不删也不看。 */
const TMP_DIR = join(tmpdir(), 'curlviz-roundtrip')

/**
 * 归一化捕获文本，只留"请求内容 + 真实报错"。
 *
 * 必修项：curl 的进度条走 stderr 的**单 `\r` 覆盖行**，里面的速度/耗时每次都不同。
 * 不归一化的话第一次跑就有大半用例被误判成 DIFF（本机实测），对拍等于废掉。
 */
function cleanWire(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .filter(
      (line) =>
        !line.includes('% Total') &&
        !line.includes('Dload') &&
        !/^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/.test(line)
    )
    .join('\n')
    .trimEnd()
}

function toRun(e: unknown): Run {
  const err = e as { code?: number | string; stdout?: string; stderr?: string; signal?: string }
  const stdout = (err.stdout ?? '').replaceAll('\r\n', '\n')
  const stderr = (err.stderr ?? '').replaceAll('\r\n', '\n')
  const code = typeof err.code === 'number' ? err.code : err.signal === 'SIGTERM' ? -1 : -2
  return { code, wire: cleanWire(`${stdout}\n@@STDERR@@\n${stderr}`) }
}

/** POSIX：交给 bash（本机 Git Bash 5.3.9，里面的 curl 是 /mingw64/bin/curl）。 */
async function runBash(command: string): Promise<Run> {
  try {
    const r = await execFileAsync('bash', ['-c', command], { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 << 20 })
    return cleanRun(0, r.stdout ?? '', r.stderr ?? '')
  } catch (e) {
    return toRun(e)
  }
}

/**
 * Windows：`cmd /d /v:off /c <命令串>` + `windowsVerbatimArguments`。
 *
 * 试过写 `.cmd` 文件再执行：**批处理解析器会把 `%2`/`%3` 当位置参数吃掉**，
 * 实测 `-d "a=b%3Dc"` 在 .cmd 里发出去的 body 成了 `a=bDc`（content-length 5），
 * 那是 .cmd 的语法，不是"用户粘进 cmd.exe"的行为，拿来判我们生成的命令坏不坏是错的。
 * 也试过 Node 默认转义（不加 windowsVerbatimArguments）：实测会把整条命令再包一层引号，
 * 线上字节变成 `-d ""a=b%3Dc""`——测的是 Node 的转义逻辑，也不是用户看到的。
 * 只有 verbatim 这一模式实测与手工粘贴逐字节一致（`%3D` 原样、引号交给 curl 解析）。
 */
async function runCmd(command: string): Promise<Run> {
  try {
    const r = await execFileAsync('cmd.exe', ['/d', '/v:off', '/c', command], {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: 8 << 20,
      windowsVerbatimArguments: true
    })
    return cleanRun(0, r.stdout ?? '', r.stderr ?? '')
  } catch (e) {
    return toRun(e)
  }
}

function cleanRun(code: number, stdout: string, stderr: string): Run {
  return { code, wire: cleanWire(`${stdout}\n@@STDERR@@\n${stderr}`) }
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

interface Case {
  id: string
  title: string
  /** 原始命令（bash 形态，URL 指向本机靶子）。 */
  cmd: string
}

/**
 * 取材说明：绝大多数命令逐字抄自《学习curl》（Hermes 本地镜像 `学习curl` mdBook，
 * curl 8.10.x 实测），靶子端口也沿用书里的 8080/8081；书里指向 example.com 的换成靶子。
 * 本机 curl 是 8.19.0，命令语义未变的部分可直接对拍。
 */
const CASES: Case[] = [
  // —— 第 3 章：基本用法 / 短选项合并 / 防 shell 展开
  { id: 'basic-get', title: '最简 GET', cmd: `curl http://localhost:${ECHO_PORT}/` },
  {
    id: 'query-amp',
    title: 'URL 带 & 必须整体加引号（书 03-03）',
    cmd: `curl 'http://localhost:${ECHO_PORT}/foo/bar?x=1&y=2'`
  },
  {
    id: 'merge-short',
    title: '短选项合并 -siX POST（书 03-02）',
    cmd: `curl -siX POST http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'option-after-url',
    title: '选项与 URL 混排（书 03-01）',
    cmd: `curl http://localhost:${ECHO_PORT}/ -A 'mycurl/0.0.1-alpha' -e http://example.com/foo/bar`
  },

  // —— 第 4 章：提交数据
  {
    id: 'data-plain',
    title: '-d 普通 k=v（书 04-01）',
    cmd: `curl -d 'foo=bar' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'data-percent',
    title: '-d 已编码值：不得二次编码（书 04-02）',
    cmd: `curl --data 'username=Tom%26Jerry' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'data-urlencode-amp',
    title: '--data-urlencode 值含 &（书 04-02）',
    cmd: `curl --data-urlencode 'username=Tom&Jerry' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'data-urlencode-eq',
    title: '--data-urlencode 值含 =（书 04-02）',
    cmd: `curl --data-urlencode 'a=b=c' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'data-space',
    title: '-d 值含未编码空格（书 04-02）',
    cmd: `curl -d 'name=foo bar' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'get-plus-data',
    title: '-G 把 -d 变成查询串（书 04-01）',
    cmd: `curl -G -d 'x=1' -d 'y=a b' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query',
    title: '--url-query 与 --data 混用（书 04-04）',
    cmd: `curl --url-query x=1 --data y=2 http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-get',
    title: '-X GET + --url-query + --data（书 04-04）',
    cmd: `curl -X GET --url-query x=1 --data y=2 http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'json-shorthand',
    title: '--json 语法糖（书 04-06）',
    cmd: `curl --json '{"foo":"bar","baz":null}' http://localhost:${ECHO_PORT}/`
  },

  // —— 第 5 章：头部
  { id: 'header-empty', title: "-H 'Accept:' 发空值头（书 05-01）", cmd: `curl -H 'Accept:' http://localhost:${ECHO_PORT}/` },
  { id: 'header-semicolon', title: "-H 'foo;' 整行原样发送（书 05-01）", cmd: `curl -H 'foo;' http://localhost:${ECHO_PORT}/` },
  {
    id: 'cookie-two-b',
    title: '两个 -b 合并成一个 Cookie 头（书 05-01）',
    cmd: `curl -b foo=bar -b session_id=XXXXXXXX http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'cookie-semi-values',
    title: "-b 'x=1;y=2' -b 'z=3'（书 11-01）",
    cmd: `curl -b 'x=1;y=2' -b 'z=3' http://localhost:${ECHO_PORT}/`
  },
  { id: 'head-i', title: '-I 而不是 -X HEAD（书 05-03）', cmd: `curl -I http://localhost:${ECHO_PORT}/` },
  { id: 'include-i', title: '-i 响应头一并输出（书 05-02）', cmd: `curl -i http://localhost:${ECHO_PORT}/` },

  // —— 第 6 章：范围请求与通配符
  { id: 'range', title: '-r 0-3 范围请求（书 06-01）', cmd: `curl -r 0-3 http://localhost:${ECHO_PORT}/hex.txt` },
  {
    id: 'glob-brace',
    title: 'URL 花括号通配：curl 自己展开（书 06-03）',
    cmd: `curl http://localhost:${ECHO_PORT}/book/{curl,shell}.pdf`
  },
  {
    id: 'glob-off',
    title: '-g 关闭通配，方括号原样发送（书 06-03）',
    cmd: `curl -g 'http://localhost:${ECHO_PORT}/dictionary/[a-c]/words'`
  },

  // —— 第 7 章：认证
  {
    id: 'basic-auth',
    title: '-u 认证（书 07-01）',
    cmd: `curl -u foo:secrets http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'auth-in-url',
    title: '凭据写在 URL 里（书 07-01）',
    cmd: `curl -I http://foobar:secrets@localhost:${ECHO_PORT}/`
  },

  // —— 第 9 章：重定向
  { id: 'redirect-no-follow', title: '不加 -L：只发一次（书 09-01）', cmd: `curl -i http://localhost:${AUX_PORT}/docs` },
  { id: 'redirect-follow', title: '-L 跟随（书 09-01）', cmd: `curl -i -L http://localhost:${AUX_PORT}/docs` },
  {
    id: 'redirect-post-drop',
    title: '-d + -L：301 后 POST 变 GET（书 09-02）',
    cmd: `curl -d 'foo=bar' -L http://localhost:${AUX_PORT}/docs`
  },
  {
    id: 'redirect-post301',
    title: '--post301 保持 POST（书 09-02）',
    cmd: `curl -d 'foo=bar' -L --post301 http://localhost:${AUX_PORT}/docs`
  },
  {
    id: 'redirect-put',
    title: '-X PUT + -L：PUT 一路保持（书 09-02）',
    cmd: `curl -X PUT -L http://localhost:${AUX_PORT}/docs`
  },
  {
    id: 'redirect-auth-crosshost',
    title: '跨主机重定向丢 Authorization（书 09-03）',
    cmd: `curl -L -u foo:bar http://localhost:${AUX_PORT}/archive`
  },
  {
    id: 'location-trusted',
    title: '--location-trusted 跨主机仍带认证（书 09-03）',
    cmd: `curl -L --location-trusted -u foo:bar http://localhost:${AUX_PORT}/archive`
  },
  {
    id: 'max-redirs',
    title: '--max-redirs 2 撞上重定向链（书 09-04）',
    cmd: `curl -L --max-redirs 2 http://localhost:${AUX_PORT}/manual1`
  },

  // —— 第 10 章：调试远程服务
  {
    id: 'resolve',
    title: '--resolve 指定 IP（书 10-01）',
    cmd: `curl --resolve localhost:${ECHO_PORT}:127.0.0.2 http://localhost:${ECHO_PORT}/`
  },

  // —— Cookie 文件与 cookie jar
  {
    id: 'cookie-jar',
    title: '-c 写 cookie 文件（书 11-02）',
    cmd: `curl -c '${join(TMP_DIR, 'jar.txt').replaceAll(/\\/gu, '/')}' -I http://localhost:${ECHO_PORT}/setcookie`
  },

  // —— 本轮对拍查出来的规则，逐条钉住（理由见各 case 上方的注释与 docs/PLAN.md 附录 A）
  {
    id: 'dup-header-two-lines',
    title: '同名 -H 是发两行，不是合并成一个值',
    cmd: `curl -H 'X-A: 1' -H 'X-A: 2' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'cookie-anchor-order',
    title: '-b 与 -H 混写时的头序（curl 把 Cookie 排在自定义头之前）',
    cmd: `curl -H 'X-A: 1' -b 'a=1' -e 'https://ref.example.com/' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'cookie-vs-h-cookie',
    title: `-b 与 -H 'Cookie: …' 同时出现时 curl 只发 -H 那条`,
    cmd: `curl -b 'a=1' -H 'Cookie: h=2' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'head-then-xget',
    title: '-I 与 -X GET 同时出现：-X 恒赢，且与书写顺序无关',
    cmd: `curl -I -X GET http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'xget-then-head',
    title: '同上，反过来写一遍（证明顺序真的不影响）',
    cmd: `curl -X GET -I http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'xget-with-body',
    title: '-X GET 带 body：不能退化成 POST',
    cmd: `curl -X GET --data 'a=1' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-space',
    title: '--url-query 的空格编成 +（拼进 URL 就变成 %20，字节不同）',
    cmd: `curl --url-query 'g=hello world' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-table',
    title: '--url-query 的编码表：~ 原样，! ( ) * 转义',
    cmd: `curl --url-query 'p=a~b!c(d)*e' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-bare-key',
    title: '--url-query x（没有等号）发成 ?x',
    cmd: `curl --url-query x http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-eq-empty',
    title: `--url-query 'x=' 发成 ?x=（与裸 x 不同，CurlSpec 分不出来）`,
    cmd: `curl --url-query 'x=' http://localhost:${ECHO_PORT}/`
  },
  {
    id: 'url-query-onto-query',
    title: 'URL 自带 ?x=1 时 --url-query 追加成 &x=2',
    cmd: `curl --url-query 'x=2' 'http://localhost:${ECHO_PORT}/?x=1'`
  }
]

interface KnownDiff {
  /** 只豁免这些列；另一列该红还是红。 */
  columns: ReadonlyArray<'posix' | 'cmd'>
  reason: string
}

/**
 * 承认的差异登记表。默认空表：任何 diff 都得先在这里写清理由，否则测试红。
 * 理由只能是三种之一：① 基线本身没发出请求，无法对拍；② CurlSpec 表达不了，属已知取舍；
 * ③ 明知是缺陷但本轮不修（必须同时在 docs/PLAN.md 附录 A 挂号待办）。
 */
const KNOWN: Record<string, KnownDiff> = {
  'get-plus-data': {
    columns: ['posix', 'cmd'],
    reason:
      '基线缺失，不是保真缺陷：原命令的 URL 没加引号，-G 把 `y=a b` 拼进去后 URL 含裸空格，' +
      'curl 直接 exit 3（实测靶子什么都没收到）。生成版把空格编成 %20 反而跑通了。'
  },
  'url-query-eq-empty': {
    columns: ['posix', 'cmd'],
    reason:
      '已知取舍（PLAN 附录 A）：实测 `--url-query x` 线上是 `/?x`，`--url-query "x="` 线上是 `/?x=`，两者不同；' +
      'CurlSpec 只存 key/value 分不出这两种写法，生成时统一取不带等号的裸 key。'
  },
  'json-shorthand': {
    columns: ['cmd'],
    reason:
      '已知缺陷（PLAN 附录 A 待修，要 rawArgs 结构化才能干净解决）：`--json` 我们不认（unknown-flag），' +
      '连 bash 的单引号一起进 rawArgs；粘进 cmd.exe 时单引号是字面字符，' +
      "实测 body 变成 `'{foo:bar,baz:null}'`（丢了所有 \" 并把 { 前引号带上）。posix 列仍须为 same。"
  },
  'cookie-anchor-order': {
    columns: ['posix', 'cmd'],
    reason:
      '只有头序不同，字段集合一致。实测 `-H "X-A: 1" -b a=1 -e R` 线上是 ' +
      'host/ua/accept → **referer → cookie → x-a**：curl 把 -e/-b 这类"引擎头"排在用户 -H 之前，与书写顺序无关。' +
      '生成版把 Cookie/Referer 还原成普通 `-H`，按命令顺序输出，于是 x-a 跑到了前面。' +
      'HTTP/1.1 的头部顺序无语义，这里用顺序换"生成的命令里头的次序看得见、可预期"。'
  },
  'header-semicolon': {
    columns: ['cmd'],
    reason:
      '同 json-shorthand，同一个根因：`-H "foo;"` 这种整行形态落 rawArgs 时保留了 bash 单引号，' +
      'cmd.exe 里 curl 收到带引号的值，实测这一行头被直接丢掉。posix 列仍须为 same。'
  }
}

/** same 之外只有"登记过且列匹配"才算通过。 */
function verdictOf(column: 'posix' | 'cmd', same: boolean, code: number, id: string): string {
  if (same) return 'same'
  if (KNOWN[id]?.columns.includes(column) === true) return 'known'
  // 生成版自己跑挂了（退出码非 0）和"跑通了但字节不同"要分开看：前者多半是引号坏了
  return code === 0 ? 'DIFF' : `RUN-FAIL(${code})`
}

function accepted(verdict: string): boolean {
  return verdict === 'same' || verdict === 'known'
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

interface Row {
  id: string
  title: string
  posix: string
  cmdShell: string
  warnings: string
  detail: string
}

function firstDiff(a: string, b: string): string {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = Math.max(la.length, lb.length)
  for (let i = 0; i < n; i += 1) {
    const x = la[i] ?? ''
    const y = lb[i] ?? ''
    if (x !== y) return `行 ${i + 1}\n  原命令 → ${x}\n  生成后 → ${y}`
  }
  return ''
}

const REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '_wip', 'roundtrip-report.md')

function writeReport(rows: Row[], meta: string[]): void {
  const head = [
    '# 真实 curl 对拍报告',
    '',
    ...meta,
    '',
    '| 用例 | 说明 | bash+posix | cmd+windows | 解析告警 |',
    '|---|---|---|---|---|'
  ]
  const body = rows.map(
    (r) =>
      `| \`${r.id}\` | ${r.title} | ${r.posix} | ${r.cmdShell} | ${r.warnings === '' ? '—' : r.warnings} |`
  )
  const known = rows
    .filter((r) => r.posix === 'known' || r.cmdShell === 'known')
    .map((r) => {
      const k = KNOWN[r.id]
      return `- \`${r.id}\`（豁免列：${k?.columns.join(' + ') ?? '?'}，本次 posix=${r.posix} / cmd=${r.cmdShell}）：${k?.reason ?? '登记信息缺失'}`
    })
  const knownSection = known.length === 0 ? [] : ['', '## 已登记的差异', '', ...known]
  const diffs = rows.filter((r) => r.detail !== '').map((r) => `\n## ${r.id}\n\n\`\`\`\n${r.detail}\n\`\`\``)
  writeFileSync(REPORT_PATH, `${head.concat(body, knownSection, diffs).join('\n')}\n`, 'utf8')
}

/* ------------------------------------------------------------------ */
/* 用例主体                                                            */
/* ------------------------------------------------------------------ */

describe.skipIf(!LIVE)('真实 curl 对拍（原命令 vs 生成命令）', () => {
  const servers: Server[] = []
  const rows: Row[] = []

  beforeAll(async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    servers.push(await startTarget(ECHO_PORT))
    servers.push(await startTarget(AUX_PORT))
    const v = await execFileAsync('bash', ['-c', 'command -v curl; curl --version | head -1'], { encoding: 'utf8' })
    bashMeta = (v.stdout ?? '').trim().replaceAll('\n', ' / ')
    const w = await execFileAsync('cmd.exe', ['/c', 'where curl & curl --version'], { encoding: 'utf8' })
    cmdMeta = ((w.stdout ?? '').split('\n')[1] ?? '').trim()
  })

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => void s.close(() => r()))
  })

  it('每条用例：parse→generate 后重新发出，线上请求必须与原命令一致', async () => {
    for (const c of CASES) {
      const original = await runBash(c.cmd)
      let generated = ''
      let winGenerated = ''
      const warnCodes: string[] = []
      try {
        const parsed = parseCurl(c.cmd)
        warnCodes.push(...new Set(parsed.warnings.map((w) => w.code)))
        generated = generateCurl(parsed.spec)
        winGenerated = generateCurl(parsed.spec, { quoteStyle: 'windows', multiline: false })
      } catch (e) {
        rows.push({
          id: c.id,
          title: c.title,
          posix: 'PARSE-ERROR',
          cmdShell: '—',
          warnings: warnCodes.join(','),
          detail: `parseCurl 抛错：${String(e)}`
        })
        continue
      }

      const again = await runBash(generated)
      const posixSame = again.wire === original.wire
      const cmd = await runCmd(winGenerated)
      // 基线只有一个：bash 里跑**原命令**收到的线上字节。
      // posix 列验"POSIX 终端粘贴生成版"，cmd 列验"cmd.exe 粘贴 windows 引号版"，
      // 两列都必须等于基线——这才是"复制到终端能跑，跑出来还是同一个请求"。
      const cmdSame = cmd.wire === original.wire

      const posixVerdict = verdictOf('posix', posixSame, again.code, c.id)
      const cmdVerdict = verdictOf('cmd', cmdSame, cmd.code, c.id)

      rows.push({
        id: c.id,
        title: c.title,
        posix: posixVerdict,
        cmdShell: cmdVerdict,
        warnings: warnCodes.join(','),
        detail:
          posixSame && cmdSame
            ? ''
            : `【原命令】\n${c.cmd}\n【生成 posix】\n${generated}\n【生成 windows】\n${winGenerated}\n【posix diff】\n${firstDiff(original.wire, again.wire)}\n【cmd diff】\n${firstDiff(original.wire, cmd.wire)}`
      })
    }

    writeReport(rows, [
      '',
      `- bash 侧：${bashMeta}`,
      `- cmd 侧：${cmdMeta}`,
      `- 靶子：127.0.0.1:${ECHO_PORT}（回显）/ ${AUX_PORT}（重定向），进程内起，跑完即关`,
      `- 用例 ${rows.length} 条；基线 = bash 里跑原命令收到的线上字节；` +
        'posix 列 = bash 里跑 posix 引号生成版，cmd 列 = cmd.exe 里跑 windows 引号生成版',
      ''
    ])

    const bad = rows.filter((r) => !accepted(r.posix) || !accepted(r.cmdShell))
    expect(bad, `与真 curl 不一致且未登记理由的用例：\n${bad.map((r) => `${r.id}: ${r.detail}`).join('\n\n')}`).toEqual(
      []
    )
  }, 300000)
})
