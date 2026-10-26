# CurlSpec 契约 v1 —— TS 与 Kotlin 的唯一事实源

> 这个目录是**双端对拍的地方**。`packages/core-ts`（Web / agent）与未来的 `android`（Kotlin）
> 各自实现解析与生成，但**判定标准只有一份**：本目录的 fixture 文件。
> 任何一端改行为，必须先改这里的用例，另一端跟着过，否则不许合并。

- 契约类型定义：`packages/core-ts/src/types.ts`（`CurlSpec` / `RequestBody` / `AuthConfig` / `RequestOptions`）
- TS 侧执行器：`packages/core-ts/test/contract.test.ts`（`npm run test --workspace @curlviz/core`）
- Kotlin 侧执行器（M3）：读同一批 JSON，断言同一批结论

约定：**fixture 只用 JSON 表达事实，不放代码**。这样安卓侧不需要任何测试框架胶水就能接。

---

## 1. fixture 文件清单

| 文件 | 覆盖面 | 条数 |
|---|---|---|
| `fixtures/url-and-query.json` | URL 形态、查询串拆分与编解码、无协议内网地址、变量 | 7 |
| `fixtures/headers-and-auth.json` | header 拆分/空值/重复、Basic/Bearer 折叠与来源 | 11 |
| `fixtures/body.json` | json / form / multipart / raw 四形态与 `-G`、`--data-urlencode` 等变体 | 15 |
| `fixtures/options-and-rawargs.json` | 开关映射、超时/代理/UA、无法映射的 flag 走 `rawArgs`、`-I` 与 `-X` 冲突、多重命令 | 14 |
| `fixtures/tokenizer-edge.json` | 续行、注释、三套引号、转义、CRLF、未闭合引号 | 12 |

新增用例请放进对应文件；开新面（例如 `--upload-file` 的 `-T` 语义）才新建文件，并同步
`contract.test.ts` 里那条"能读到 N 个 fixture 文件"的清单。

---

## 2. 单条用例的字段含义

```json
{
  "id": "post-json-explicit-ct",
  "title": "POST JSON，显式 Content-Type",
  "tags": ["body", "json"],
  "canonical": true,
  "curl": "curl 'https://api.example.com/items' \\\n  -X POST \\\n  ...",
  "spec": { "method": "POST", "url": "...", "body": { "type": "json", "json": "{\"a\":1}" } },
  "expectWarnings": []
}
```

| 字段 | 必填 | 语义 |
|---|---|---|
| `id` | ✅ | 全局唯一，测试名用它，改 id 等于删用例 |
| `title` | ✅ | 中文说明这条用例在钉什么；测试会把它打印成用例名 |
| `tags` | ✅ | 至少一个，便于按面筛（`body` / `url` / `tokenizer` / `auth` …） |
| `canonical` | ✅ | `true` ⇒ 生成方向必须**逐字符**相等，见 §3 |
| `curl` | ✅ | 输入命令串，**必须是生成器能产出的形态**（`-X` 在选项前、每行两个空格缩进），否则 canonical 用例会假失败 |
| `spec` | ✅ | 期望解析结果，**partial**：只写关心字段，没写的字段一律不校验 |
| `expectWarnings` | ✅ | 必须出现的 warning `code` 集合；不校验条数与文案，也不禁止额外 warning |

`spec` 里可以省略的对象同样按 partial 处理（比如 `auth` 只写 `{"type":"bearer","bearer":{"token":"T"}}`，
`basic` 不校验）。这是故意的：契约不该被无关字段的默认值绑死。

### warning code 语义

| code | 触发条件 |
|---|---|
| `shell-substitution` | flag 或值里出现 `$VAR` / `${VAR}` / `$(cmd)` / 反引号，原文保留但不保证等价 |
| `multiple-commands` | 一条输入里有第二条 curl（`;` `|` `&` 或换行分隔），只解析第一条 |
| `unknown-flag` | 未识别的长选项，已连同取值进 `rawArgs` |
| `extra-url` | 多个 URL 位置参数，只第一个进 `url` |
| `data-urlencode-lossy` | `--data-urlencode` 的 `@file` / 裸内容形态，按 `name=value` 近似映射 |
| `malformed` | 结构不完整但已尽力（缺 URL、未闭合引号、`-u` 与 Authorization 头冲突等） |
| `flag-conflict` | 两个 flag 都认识但语义冲突，按优先级取其一，**其余原样进 `rawArgs`**（当前唯一实例：`-I` 遇上 `-X GET`） |

---

## 3. 三条测试义务

### 3.1 parse：`parseCurl(curl).spec ⊇ fixture.spec`

partial 比对，逐字段报路径（`body.form[1].value: 'x' ≠ 期望 'y'`），一屏看全错位。

### 3.2 generate（`canonical: true`）：`generateCurl(parseCurl(curl).spec) === curl`

起点是 **parse 出来的完整 spec**，不是 fixture 里的 partial spec。
理由：拿手抄的 partial 去生成，parse 与 generate 两端的不对称会被"期望值抄错"掩盖掉——
这类 bug 最后都以"复制到终端跑不通"的形式回到用户手上，最难查。

### 3.3 往返：`parse(generate(parse(curl)))` 规范化后必须等于 `parse(curl)`

这条不许失败。它保证"粘进来 → 编辑 → 复制出去 → 再粘回来"不丢语义。
比较前先做**规范化**，三条规则都是有意的，不是和稀泥：

1. **空 body 归一到 `none`**：`json` 全空白、`raw` 空串、`form`/`multipart` 空数组，生成时都不产生
   body 参数，与 `none` 等价。不归一的话"空 raw"绕一圈变 `none` 会被误报成丢数据。
2. **`auth.type === 'none'` 时清空 `basic` / `bearer`**：残留值不参与发送也不会被生成。
3. **warnings 不进比较**：第二次解析不该再出现词法类警告，条数差是噪音。

---

## 4. 生成方向规则（Kotlin 照抄这一节）

### 4.1 输出顺序（canonical 依赖它）

```
curl <URL>
  [ -X METHOD | -I ]   方法非 GET 才输出；HEAD 输出 -I，其余输出 -X METHOD（大写）
  [ 选项 ]             -L → -k → --compressed → -m → --connect-timeout → -A → -x
  [ headers ]          按 spec.headers 原顺序
  [ auth ]             basic → -u；bearer → -H 'Authorization: Bearer …'
  [ 自动 Content-Type ] 仅 json 体且用户没自己写 CT
  [ body ]
  [ rawArgs ]          原样追加，顺序不变
```

多行时缩进规则：`curl …` 那一行**永远顶格**，它后面的每一条参数行前两个空格；行尾带 ` \`，最后一行不带。
`# 注释` 行永远不带续行符，也不缩进——即 `withNameComment` 打开时是「注释行顶格 + curl 行仍顶格 + 其余缩进」
（M0 实现时这里踩过一次，只按"下标 0"判断缩进会把 curl 行也缩进去）。

**HEAD 为什么输出 `-I` 而不是 `-X HEAD`**：两者请求行一样，但 `-X HEAD` 只是改方法名，
curl 仍然**等一个永远不会来的响应体**，命令看起来卡死——这是社区公认的坑。`-I` 才是
"HEAD 且不等 body"。`CurlSpec.method` 表达不了"等不等 body"，所以两端统一取不卡死的那个写法：
`-X HEAD` 进来会被规范成 `-I`，不带告警。

### 4.2 引号

| 场景 | posix（默认，bash/Git-Bash/macOS/Linux） | windows（cmd.exe / PowerShell） |
|---|---|---|
| 包裹 | `'…'` | `"…"` |
| 值内单引号 | `'\''` | 不处理（双引号内单引号无需转义） |
| 值内双引号 | 不处理 | `\"` |
| 值内反斜杠 | 不处理 | 先 `\\` 翻倍，再转义引号 |

`'\''` 是 shell 语法，**cmd.exe 不认**——本机 curl 8.19.0 实测会收到字面 `''\''quick\'''`，
所以 Windows 用户必须切 `quoteStyle: 'windows'`，这不是可选项。

### 4.3 三条硬约束

1. **`{{变量}}` 永不被 percent-encode**。URL/query 编码走"变量段原样、其余编码"，
   否则生成 `%7B%7Btoken%7D%7D`，命令直接废。
2. **auth 与 headers 互斥**：`auth.type ≠ none` 时，同名 `Authorization` 头不再输出，
   否则 curl 真发两个认证头。
3. **multipart 文本项含 `;` / `@` / `<` 时用 `--form-string`**：`-F` 会把这些字符当指令解析
   （`@file`、`;type=`），等于把用户的数据改写成请求结构。

### 4.4 其它映射

| CurlSpec | 输出 |
|---|---|
| `query[]` | percent-encode 后拼进 URL（`url` 已带 `?` 时用 `&` 续接）；`enabled=false` 或空 key 不输出 |
| `headers[]` 值为空串 | `-H 'K:'`（curl 语义是发空值头，不是删头） |
| `body=form` | `-d 'k=v&k2=v2'`，逐项 percent-encode |
| `body=raw` | `--data-binary '…'` |
| `options.timeoutMs` | `-m <秒>`（总时限）；`0` 不输出 |
| `options.connectTimeoutMs` | `--connect-timeout <秒>`；`0` 不输出 |
| `rawArgs[]` | 原样 |

---

## 5. 解析方向规则

### 5.1 分词（对齐 bash，已用真实 bash 5.2.21 对拍）

- 单引号内一切字面量，`\` 不特殊；双引号内只认 `\$ \\ \" \`` 与 `\`+换行；`$'...'` 支持
  `\n \t \r \b \f \v \a \e \\ \' \" \xNN \uNNNN \UNNNNNNNN` 与八进制，未知转义丢反斜杠
- 引号外 `\`+换行 = 续行；换行后残留的空格/制表一起吃掉；`\` 后直接跟空格**不是**续行（转义的是那个空格）
- **`'a'\<newline>b` 拼成一个词 `ab`**——这是 bash 的真实语义，我们不改（实测对齐 bash 5.2.21）
- 词首 `#` 吃到行尾；词内 `#` 不算；引号内 `#` 不算
- 引号外 `;` `|` `&`（含 `&&` `||`）与未转义换行 = 命令边界，在此截断，只解析第一条并告警

### 5.2 三条硬规则

1. **认得但 CurlSpec 表达不了的 flag**（`-s` `-v` `-o` `--retry` `--cacert` …）连值一起进 `rawArgs`，
   保证复制到终端行为等价，不被悄悄改掉。
2. **Authorization 头识别成 auth 后必须从 headers 移除**（`Bearer` 直取；`Basic` 需是合法 base64
   且解出来含 `:`，否则保留为普通头并告警）。
3. **未知长选项默认按"带值"处理**（`--cacert ./ca.pem`），否则 `./ca.pem` 会被当成 URL；
   已知布尔集优先，避免把 URL 吞成布尔值。

### 5.3 与 bash 的三处**刻意**不一致

| 场景 | bash | 我们 | 原因 |
|---|---|---|---|
| 续行中间夹 `#` 注释行 | 命令在注释处结束 | 视为同一条命令 | 用户从文档/笔记粘贴的形态，报错不如宽容 |
| 未被 `;`/`|`/`&` 分隔的裸换行 | 命令边界 | 当空白继续 | 粘贴时换行是被硬折的，不是用户的命令分隔意图 |
| 引号外的 `(`/`)` | 子 shell 语法 | 当命令边界 | curl 命令里出现裸括号基本就是另一条命令 |

### 5.4 方法推断优先级

`-X` 显式 > `-I/--head` → `HEAD` > `-G/--get` → `GET` > 有 `-d`/`-F` → `POST` > `GET`

`-I` 输给 `-X` 时**不是丢弃**：`-I` 原文进 `rawArgs`；胜出方法是 `GET` 时连 `-X GET` 一起进
（生成器对 GET 不输出 `-X`，不留就会被规范成裸 `-I`，方法从 GET 翻成 HEAD），胜出方法非 `GET`
时只留 `-I`（`-X` 由生成器自己会输出，留了就重复）。两种情况都给 `flag-conflict`。

---

## 6. body 归类的判定（最容易两端跑偏的地方）

多个 `-d` 按 curl 语义用 `&` 连接成 `joined`，然后按顺序判：

1. `Content-Type` 含 `json`，或（没有 CT 且**全部**来自 `-d/--data-raw/--data-urlencode` 且 `joined` 能
   `JSON.parse`）→ `json`
2. `--data-urlencode` 独占全部输入 → `form`（近似映射，必要时给 `data-urlencode-lossy`）
3. `joined` 通过 **form 自校验** → `form`
4. 其余 → `raw`（用 `--data-binary` 回吐，保留字节）

**form 自校验**：把 `joined` 按 `&` 拆开、逐项 percent-decode、再逐项 encode，必须**逐字符等于原文**。
原因：生成方向会对 form 的 key/value 重新编码，而 curl 的 `-d` 不解码。
`-d 'email=a@b.com'` 若落进 form，出去就变成 `email=a%40b.com`——实际发送的字节改了。
所以这种宁可保持 `raw` 原文，也不悄悄改写用户的请求。同理 `-d 'name=foo bar'`（未编码空格）、
`-d 'a=b+c'`（`+` 形态）、`$'name=foo\nvalue=bar'`（真换行）都留在 `raw`。

`--data @file` / `--data-binary @file` 读不到文件内容，**不猜**：原样进 `rawArgs` + `unknown-flag` 告警。

---

## 7. 变量

- 语法 `{{name}}`，`\{{name}}` 是转义（输出字面量 `{{name}}`，不参与替换、不计入未解析告警）
- 替换是 `String.replace` 单趟扫描：变量值里含 `{{x}}` 不会被二次展开，不需要额外防护
- 未解析变量**原样保留并报名字**。绝不替换成空串——那会发出一个打到错误地址的请求，比报错危险
- 作用域：`url`、`query[]`、`headers[]`、`body.json/raw/form[]/multipart[]`、`auth.basic/bearer`、
  `options.userAgent/proxy`、`rawArgs[]`
- 多环境合并：活动环境覆盖非活动环境，同名变量后声明者覆盖；`enabled=false` 的变量不参与

---

## 8. 集合文件

```json
{ "format": "curlviz-collection", "version": 1, "environments": [], "requests": [] }
```

`format` 不匹配就报错并提示"可能来自其它工具，请先导入再导出"，不静默接受。
所有外部入口（文件导入、历史反序列化、安卓二维码）先过 `normalizeSpec`：字段缺失/类型错一律退回默认，
不在用户双击文件那一刻崩在 UI 里。

**脱敏**（分享与历史的默认形态）：`Authorization` / `Cookie` / `*api-key*` 等头、`auth.basic.password`、
`auth.bearer.token`、名字含 `token|secret|password|key|sig|auth` 的 query 值，以及 **`rawArgs` 里的
`-u` / `--proxy-user` / `--oauth2-bearer` / 敏感头**。
`rawArgs` 这一条容易漏：解析失败的命令同样会进历史，`-u bob:pw` 原样躺在那儿。

---

## 9. 与 PLAN.md 的偏离登记

PLAN 的 v1 契约表有两处不足，代码已按下列方式实现，**等用户确认后回填 PLAN**：

1. **`timeoutMs` 一个字段接了两个 curl flag**。PLAN 把解析侧的 `--connect-timeout` 与 `-m/--max-time`
   都映射到 `timeoutMs`，生成侧只出 `--connect-timeout`。后果是 `curl -m 30` 被改写成
   `--connect-timeout 30`——建连后不再受总时限约束，直接违反 PLAN 自己的"保证往返不丢数据"。
   现方案：`options.timeoutMs → -m`（总时限），新增 `options.connectTimeoutMs → --connect-timeout`。
2. **生成侧需要引号风格开关**。PLAN 只写了 POSIX 的 `'\''`，而 cmd.exe 不认这个语法（本机 curl 实测收到
   字面量）。现方案：`GenerateOptions.quoteStyle: 'posix' | 'windows'`。

M0 实现期间另外发现并已在本文档写明的问题：form 自校验（§6）、`--form-string` 选择（§4.3）、
`rawArgs` 脱敏（§8）、multipart `filename=` 的往返（fixture `post-multipart-filename-and-type`）。
