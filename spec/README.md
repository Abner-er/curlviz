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
| `fixtures/book-curl.json` | 取材《学习 curl》的 20 条：`-siX POST` 合并、`-G`/`--url-query`/`--data` 混用、多 `-b` 合成、`-H 'k;'`、`-r` 多段、`-T`、`--json`、`-w/-s/-o`、URL 内嵌凭据、花括号/方括号通配 | 20 |

合计 79 条，其中 `canonical: true` 47 条。期望值的来源分两批，说清楚免得后来人照着错的信：

- `book-curl.json` 那 20 条**逐条抄自实测**：先把命令过一遍 `parseCurl` + `generateCurl` 倒进 `_wip/dump.json`
  读规范形态，再用真实 curl 8.19.0 对拍确认线路语义，最后把跑出来的输出抄进 fixture，没有一条凭记忆手写。
- 其余五个文件写于 M0，期望值当时是按实现加推理定的。本轮用 `packages/core-ts/test/roundtrip.live.test.ts`
  （`CURLVIZ_LIVE=1` 可重跑）复核了其中的线路语义，**发现的四处分歧全部按 curl 改写**：多个 `-b` 用 `"; "`
  合成一个 Cookie 头、同名 `-H` 不合并、隐式 POST 不补 `-X`、`--url-query` 独立成条（见 §4.1 / §4.4 / §5.2）。
  对拍没覆盖到的那些条仍然只是"我们自己一致"，不等于 curl 认可——**动它们之前先补一条对拍用例**。

新增用例优先放进已有文件；开新面才新建文件，并同步 `contract.test.ts` 里那三条绊线
（用例总数、文件数、排序后的文件名清单）。

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
  [ -X METHOD | -I ]   见下面的"何时输出 -X"
  [ --url-query ]      viaUrlQuery=true 的 query 项，按 query[] 原顺序
  [ 选项 ]             -L → -k → --compressed → -m → --connect-timeout → -A → -x
  [ headers ]          按 spec.headers 原顺序
  [ auth ]             basic → -u；bearer → -H 'Authorization: Bearer …'
  [ 自动 Content-Type ] 仅 json 体且用户没自己写 CT
  [ body ]
  [ rawArgs ]          原样追加，顺序不变
```

**何时输出 `-X`**（实测逼出来的规则，v1 那张"方法非 GET 就输出"的写法会把请求改掉）：

- `method === 'HEAD'` → 输出 `-I`，永远不输出 `-X HEAD`。
- 其余情况：`methodExplicit === true`（用户命令里真写了 `-X`）**或** curl 自己猜不出这个方法
  （有 body 参数却不是 POST、没 body 参数却是 POST）时，输出 `-X METHOD`。
- 隐式 POST（只有 `-d`/`-F` 没写 `-X`）**不补** `-X POST`：实测 `-d … -L` 在 301 之后降成 GET，
  而 `-X POST -d … -L` 一路保持 POST。补上 `-X` 等于换了请求语义，这正是运维最在意的那类差异。

`methodExplicit` 因此是契约字段：解析侧写它，生成侧读它，Kotlin 两端都必须带。
HEAD 是唯一把显式性丢掉的情况——`-X HEAD` 进来会被规范成 `-I`，`methodExplicit` 落成 `false`，
否则往返第二次会从 true 翻成 false，破 §3.3 的幂等契约。

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
| `query[]`（`viaUrlQuery` 不为真） | percent-encode 后拼进 URL（`url` 已带 `?` 时用 `&` 续接）；`enabled=false` 或空 key 不输出 |
| `query[]` 里 `viaUrlQuery=true` 的行 | 单独输出 `--url-query 'k=v'`（值为空串时只写 `--url-query 'k'`）。**不许折进 URL**：curl 自己那张编码表跟 `encodeURIComponent` 不是一份 —— 实测空格发成 `+`、`!` 发成 `%21`、`(`/`)`/`*` 发成 `%28`/`%29`/`%2A`、`~` 原样，而 `encodeURIComponent` 恰好反过来（空格 `%20`、`!~*'()` 原样）。交给 curl 去编码才是用户粘到终端上跑出来的那个请求 |
| `headers[]` 值为空串 | `-H 'K:'`。**curl 的语义是"删掉这个头"**，不是发空值头（实测 `-H 'Accept:'` 连默认的 `Accept: */*` 一起不发、`-H 'User-Agent:'` 不发 UA、`-H 'Referer:'` 能把 `-e` 给的 Referer 也删掉）；同名再给一条真值时线路上只有真值那一行（`-H 'X-Dup:' -H 'X-Dup: v'` → 只发 `X-Dup: v`）。要"发一行空值头"得写 `-H 'K;'`，curl 8.19.0 实测发的是 `K:`；这种形态我们建模不了，连引号原样进 `rawArgs`（见 fixture `book-header-semicolon-line`） |
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

### 5.2 解析侧的硬规则

1. **认得但 CurlSpec 表达不了的 flag**（`-s` `-v` `-o` `--retry` `--cacert` …）连值一起进 `rawArgs`，
   保证复制到终端行为等价，不被悄悄改掉。
2. **Authorization 头识别成 auth 后必须从 headers 移除**（`Bearer` 直取；`Basic` 需是合法 base64
   且解出来含 `:`，否则保留为普通头并告警）。
3. **未知长选项默认按"带值"处理**（`--cacert ./ca.pem`），否则 `./ca.pem` 会被当成 URL；
   已知布尔集优先，避免把 URL 吞成布尔值。
4. **多个 `-b` 合成一个 Cookie 头，连接符是 `"; "`**（实测 curl 8.19.0：`-b foo=bar -b session_id=X`
   发出去的是 `Cookie: foo=bar; session_id=X`）。合成后的头**插回第一条 `-b` 出现时 headers 的长度位置**，
   于是 Cookie 与自定义 `-H` 的相对顺序跟着命令走。同一条命令里另有 `-H 'Cookie: …'` 时按 curl 让 `-H` 赢、
   把 `-b` 整个丢弃并给 `flag-conflict`（实测 curl 就是这么处理冲突的）。
   旧实现是每条 `-b` push 一个头、再用逗号拼接，线上发成 `a=1,b=2` —— Cookie 头形状非法，服务端直接不认。
5. **同名 `-H` 不合并**：实测 `-H 'X-A: 1' -H 'X-A: 2'` 线上就是发两行，逗号拼接等于偷偷改了请求。
   唯一的例外是 Content-Type（`addHeader` 取后者），因为两条 CT 会让 body 归类摇摆不定。

### 5.3 与 bash 的三处**刻意**不一致

| 场景 | bash | 我们 | 原因 |
|---|---|---|---|
| 续行中间夹 `#` 注释行 | 命令在注释处结束 | 视为同一条命令 | 用户从文档/笔记粘贴的形态，报错不如宽容 |
| 未被 `;`/`|`/`&` 分隔的裸换行 | 命令边界 | 当空白继续 | 粘贴时换行是被硬折的，不是用户的命令分隔意图 |
| 引号外的 `(`/`)` | 子 shell 语法 | 当命令边界 | curl 命令里出现裸括号基本就是另一条命令 |

### 5.4 方法推断优先级

`-X` 显式 > `-I/--head` → `HEAD` > `-G/--get` → `GET` > 有 `-d`/`-F` → `POST` > `GET`

实测 `-X` 恒赢，且与书写顺序无关（`curl -I url -X GET` 与 `curl -X GET url -I` 都是 GET）。

`-I` 输给 `-X` 时**不是丢弃**：`-I` 原文进 `rawArgs` 并给 `flag-conflict`。
`-X` **不再一起回填**——`methodExplicit=true` 时生成器自己就会输出 `-X METHOD`，留下原文等于发两条 `-X`。
（旧规则是"GET 不输出 `-X`"，那时必须回填，否则重新生成只剩裸 `-I`、方法从 GET 翻成 HEAD；
§4.1 的"何时输出 `-X`"改掉之后，这个补丁就撤销了。fixture `head-conflict-x-get` 钉的是新形态。）

`--url-query` 不参与方法推断：`curl --url-query x url` 仍是 GET。它与 `-G` 是两条不同的通道
（`-G` 把 `-d` 折进查询串，`--url-query` 自己就是查询串的一部分，追加时带 `&`），
所以用 `viaUrlQuery` 标记而不是把它们并到一列里。实测 `-G --url-query a -d b=2` 时 curl 会**丢掉**
`--url-query` 那项，我们不模仿这个丢弃（表单里两条都在），差异记在 §10。

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

**遮盖的形状**：整串替换为 `••••••••`，**不保留原文任何片段**。
早期写法是「首 3 位 + 点 + 尾 3 位」，那时脱敏结果只在本地历史列表里看一眼，留头尾方便认出是哪条；
M2 起脱敏结果会通过分享码 / 导出文件**离开本机**，而它把首尾各 3 个字符和精确长度一起交了出去 ——
够对方把这条凭据对上号（同一个 token 在别处也出现过时尤其有用）。
Kotlin 侧照此实现，别再回到留首尾的写法。

---

## 9. 分享载荷（curlviz:1:）

M2 起「一个请求」或「整个集合」可以编成一段文本，走链接或二维码传给同事。
安卓端（M3）**必须能解开网页端生成的码**，所以格式在这里钉死。TS 侧实现：`web/src/lib/share.ts`。

### 9.1 字符串结构

```
curlviz:1:<mark><base64url(payload bytes)>
```

- 前缀 `curlviz:1:` —— `1` 是格式版本。读不出前缀直接报错，不猜。
- `<mark>` 单个字符：`g` = gzip，`p` = 明文 JSON。除 `g`/`p` 以外的一律报「不认识的压缩标记」。
- 载荷字节 = `JSON.stringify(SharePayload)` 的 UTF-8。`p` 时直接 base64url；
  `g` 时先 gzip 再 base64url。**若 gzip 结果不比明文短，编码器必须退回 `p`**（极小载荷会这样）。
- base64url：`+`→`-`、`/`→`_`、去掉尾部 `=`。解码时补回 padding。
  这一段是二进制安全的，`atob/btoa` 只保证 latin1，所以必须先按字节拼串再编码
  （`bytesToBase64Url` 的写法），Kotlin 侧用等价的 `Base64.URL_SAFE | NO_WRAP | NO_PADDING`。

### 9.2 payload JSON 形状

```json
{ "kind": "request", "spec": { "...": "CurlSpec v1" }, "redacted": true, "at": 1730000000000 }
{ "kind": "collection", "collection": { "format": "curlviz-collection", "version": 1, "environments": [], "requests": [] }, "redacted": false, "at": 1730000000000 }
```

- `kind` 只认 `request` / `collection`，缺 `kind` 或认不出的一律拒绝。
- `spec` / `collection.requests` 解出来**必须先过 `normalizeSpec`**（同 §8 的入口规则），
  因为这份 JSON 可能来自更新的版本或被人手改过。
- `redacted` 表示载荷里的凭据已被抹掉。它只是**给人看的事实标记**，解码方不能靠它做安全判断——
  伪造 `redacted: true` 就能骗过提示。界面上同时要显示「没勾脱敏 ⇒ 凭据原样在码里」。
- **脱敏管不到 `environments`**。`redactSpec` 只处理请求头 / auth / query / rawArgs 里的凭据。
  环境值不是"没判据所以不遮"，而是**遮了这份载荷就没用了** —— 带环境出去的目的就是让对方拿到
  真实的网关地址与 token。所以安全的默认是「不带环境」：生成方必须让它默认不勾，
  勾上时（哪怕仍脱敏）明确提示"环境里的值原样出去"。安卓侧照此办理，
  别让人以为勾了脱敏扫出去的码就没有 token。
- `at` 是生成时间戳（毫秒），仅用于展示与排查；缺失时解码方填当前时间，不参与任何校验。

### 9.3 传输方式与容量

- 落地形态是 URL 的 **hash 片段**：`https://…/#share=<编码结果>`。
  走 hash 的原因：hash 不进服务端访问日志、不进 `Referer`，也不会被爬虫带走。
  解码方要能接受三种输入：完整 URL、`share=...`、纯编码串。
- 压缩只用**宿主原生 gzip**（浏览器 `CompressionStream('gzip')`；安卓用 `GZIPOutputStream`），
  不接任何第三方 codec / 短链 / 二维码 API —— 那等于把内网接口地址交给外部。
- 二维码容量：`1024` 字节以内算好扫，`2600` 字节是硬上限（QR v40 byte 模式理论 ~2953 字节，
  但机房门口对着手机扫那么密的码扫不出来）。超上限就只给链接或导出文件，别硬生码。

### 9.4 参考样本（给 M3 对拍）

明文标记（`p`）的样本：载荷 JSON 617 字节，编码后整串 834 字符；同一份内容改走 gzip 是 554 字符。

```
curlviz:1:peyJraW5kIjoicmVxdWVzdCIsInJlZGFjdGVkIjp0cnVlLCJhdCI6MTczMDAwMDAwMDAwMCwic3BlYyI6eyJ2ZXJzaW9uIjoxLCJuYW1lIjoi56S65L6L77ya5Y-W5Zue5LiA5Liq55So5oi3IiwibWV0aG9kIjoiR0VUIiwidXJsIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdXNlcnMvNDIiLCJxdWVyeSI6W3sia2V5IjoidmVyYm9zZSIsInZhbHVlIjoiMSIsImVuYWJsZWQiOnRydWV9XSwiaGVhZGVycyI6W3sia2V5IjoiQWNjZXB0IiwidmFsdWUiOiJhcHBsaWNhdGlvbi9qc29uIiwiZW5hYmxlZCI6dHJ1ZX1dLCJib2R5Ijp7InR5cGUiOiJub25lIiwianNvbiI6IiIsImZvcm0iOltdLCJtdWx0aXBhcnQiOltdLCJyYXciOiIifSwiYXV0aCI6eyJ0eXBlIjoiYmVhcmVyIiwiYmFzaWMiOnsidXNlcm5hbWUiOiIiLCJwYXNzd29yZCI6IiJ9LCJiZWFyZXIiOnsidG9rZW4iOiLigKLigKLigKLigKLigKLigKLigKLigKIifX0sIm9wdGlvbnMiOnsiZm9sbG93UmVkaXJlY3RzIjp0cnVlLCJpbnNlY3VyZSI6ZmFsc2UsImNvbXByZXNzZWQiOnRydWUsInRpbWVvdXRNcyI6MTAwMDAsImNvbm5lY3RUaW1lb3V0TXMiOjAsInVzZXJBZ2VudCI6IiIsInByb3h5IjoiIn0sInJhd0FyZ3MiOltdfX0
```

解开后的载荷 JSON（就是 §9.2 的形状，`at` 固定在 1730000000000 才能当样本）：

```json
{"kind":"request","redacted":true,"at":1730000000000,"spec":{"version":1,"name":"示例：取回一个用户","method":"GET","url":"https://api.example.com/users/42","query":[{"key":"verbose","value":"1","enabled":true}],"headers":[{"key":"Accept","value":"application/json","enabled":true}],"body":{"type":"none","json":"","form":[],"multipart":[],"raw":""},"auth":{"type":"bearer","basic":{"username":"","password":""},"bearer":{"token":"••••••••"}},"options":{"followRedirects":true,"insecure":false,"compressed":true,"timeoutMs":10000,"connectTimeoutMs":0,"userAgent":"","proxy":""},"rawArgs":[]}}
```

**验收只看解码方向**：各端要求是"给定上面那串，解出的字段与这段 JSON 一致"。
不许拿"生成的字节必须等于这串"当条件——`JSON.stringify` 的键序跟着对象构造顺序走，
`redactSpec` 与 gzip 的输出头（mtime / OS 字节）也不是跨端可复现的，钉死了只会让两端互相迁就假象。
TS 侧把这条钉在 `web/src/lib/share.test.ts` 的「跨端参考样本」里，改格式必须同时改文档与这三条断言。

---

## 10. 与 PLAN.md 的偏离登记

PLAN 的 v1 契约表有两处不足，代码已按下列方式实现，**等用户确认后回填 PLAN**：

1. **`timeoutMs` 一个字段接了两个 curl flag**。PLAN 把解析侧的 `--connect-timeout` 与 `-m/--max-time`
   都映射到 `timeoutMs`，生成侧只出 `--connect-timeout`。后果是 `curl -m 30` 被改写成
   `--connect-timeout 30`——建连后不再受总时限约束，直接违反 PLAN 自己的"保证往返不丢数据"。
   现方案：`options.timeoutMs → -m`（总时限），新增 `options.connectTimeoutMs → --connect-timeout`。
2. **生成侧需要引号风格开关**。PLAN 只写了 POSIX 的 `'\''`，而 cmd.exe 不认这个语法（本机 curl 实测收到
   字面量）。现方案：`GenerateOptions.quoteStyle: 'posix' | 'windows'`。

M0 实现期间另外发现并已在本文档写明的问题：form 自校验（§6）、`--form-string` 选择（§4.3）、
`rawArgs` 脱敏（§8）、multipart `filename=` 的往返（fixture `post-multipart-filename-and-type`）。
M2 期间新增：脱敏遮盖不留首尾（§8）、分享载荷格式（§9）。

范围分工，免得翻错地方：本节只登记 **M0 那两处契约表不足**；分享码的格式在本文 §9；
M2 必须先定的四条规矩（分享格式、脱敏遮盖形状、多环境迁移的冲突策略、导入永不覆盖）
与两条"故意不做"（一键清空、`window.confirm`）写在 `docs/PLAN.md` §9。

### 10.1 与真实 curl 的已登记差异

对拍跑出来的、**暂时决定不修**的差异。列在这里是因为它们都会被用户撞到，
"知道差在哪"比"看起来没有差异"有用。判据写在 `roundtrip.live.test.ts` 的 `KNOWN` 表里，
按列登记（同一用例允许 cmd 侧差，但不许拿一个理由同时放过两列）。

| # | 现象 | 为什么不立刻改 | 什么情况下必须改 |
|---|---|---|---|
| 1 | `rawArgs` 里存的是 **bash 引号原文**（`--json '{"a":null}'`、`-H 'foo;'`），切到 windows 风格时原样吐出单引号 → cmd.exe 不认，值就漏了 | 干净修法是把 `rawArgs` 从"字符串数组"改成结构化（flag + 值 + 是否带引号），那是契约 v2，要动 Kotlin 端与所有已存集合文件 | 一旦"粘到 cmd 跑不通"成为实际投诉，或 M4 本地 agent 要在 cmd 下代跑，就必须先做这个结构化 |
| 2 | `--url-query x` 与 `--url-query 'x='` 在线路是两种请求（`/?x` vs `/?x=`），`CurlSpec` 的 `query[]` 只有一份表示，统一收成 `k=x, v=''` | 要分就得给 Param 加"有没有等号"的标志位，同样是契约 v2；现在两种写法生成出来都是 `--url-query 'x'` | 有人靠空值参数做接口判别时 |
| 3 | `-G` 与 `--url-query` 同时出现时 curl **丢掉** `--url-query` 那项，我们的表单里两条都在、都会输出 | 模仿"丢弃"等于悄悄删用户填的数据；保留更符合"表单是意图"的定位，且这条组合本身是 curl 的已知怪癖 | 若对拍证明它会让人生成错请求，就改成给告警而不是静默保留 |
| 4 | curl 把 Cookie 当**引擎头**：`-b` 写在 `-H` 前面还是后面，线上 Cookie 永远排在自定义头之前。我们是**按命令顺序插**（锚点 = 第一条 `-b` 出现的位置），于是 `-H 'X: y' -b 'a=1'` 这种写法线上头序与 curl 相反 | 主动换的：跟着命令走，生成的命令里 `-H` 的顺序和用户写的一致，编辑与对照都省事；HTTP/1.1 的头序本身无语义 | 遇到按头序判别的服务器（极少见，且这种服务多半也看顺序之外的东西），那时改成"引擎头一律提前" |
| 5 | 网页端"发送"走 `fetch`，与 curl 不是一套：`-H 'K:'` 表达的"删头"在 fetch 里没法表达、查询串编码用 `encodeURIComponent`（§4.4 那张 curl 自己的表复现不了）、`rawArgs` 完全跳过 | 网页端本来就只能发"它能发的部分"，命令原文才是交付物；已经在结果区显示告警 | 任何把"网页发送结果"当成对拍标准的做法都不成立，M3/M4 一律以 curl 二进制为准 |

---

## 11. 不进跨端契约的本地格式

下面这些是**某一端自己的存储**，另一端不需要实现，也不要拿它们当对拍标准：

- **`curlviz-backup` v1**（`web/src/lib/backup.ts`）：网页端「一次导出全部家当」的文件，
  形状是 `{ format: "curlviz-backup", version: 1, collections: [...], environments: [...], activeName }`。
  它内嵌的每条请求仍然是 `curlviz-collection` 里的 `CurlSpec v1`，所以**契约部分照旧对拍**，
  只有外层包装与「恢复时一律给新 id、重名加序号、版本比本端高就拒收」这条策略是网页端独有的。
  安卓若要做备份，另立自己的格式，别来改这个 —— 它带 `activeName` 这种纯 UI 概念。
- **localStorage 的各键**（历史、变量、`openRef`）：读出来先过 sanitize 再用（丢坏条目、
  保留 id、活动环境指不到就当没指）。这是「用户可能在 DevTools 里手改过、或版本不同字段有增减」的防线，属于端的实现细节。
- **`openRef`**：记「编辑器当前打开的是哪个集合里的哪条请求」，只有本端有意义；
  跨端传过来的集合导入后 id 会变，所以导入路径不允许沿用它传来的 id。

---

## 12. `--resolve` 结构化（已实现，契约仍为 v1）

> **状态：已实现。** `--resolve` 已从 `rawArgs` 提升为 `options.resolve` 结构化字段，`types.ts` / `parse.ts` / `generate.ts` / `collection.ts` / fixtures 全部落地，契约测试与真实 curl 对拍均绿。判据抄自本机 curl 8.19.0 实测（见下方"实测结论"），不是凭记忆写的。

**解决的 flag**：`curl --resolve <host>:<port>:<addr>`（可重复）。运维用它把某个域名强制解析到指定 IP——绕开 DNS、直连某台内网/灰度节点、切 hosts 之前先验目标。**浏览器 `fetch` 表达不了它**（§10.1 #5），只有真 curl（M4 agent）能跑，所以它是"远程执行"落地的第一批结构化 flag。

**字段**（`RequestOptions`，可重复）：

```jsonc
"options": {
  // …现有字段不变…
  "resolve": [
    { "host": "api.internal", "port": 443, "addr": "10.0.0.5" }
  ]
}
```

`addr` 原样存字符串（IPv6 带方括号时连方括号一起留），端口是 0–65535 的十进制整数。字段是**新增且可选**：缺失时 `normalizeOptions` 补 `[]`，所以 `CURLSPEC_VERSION` 仍是 1，没有触发整份 v2 迁移。

**解析方向**：`--resolve host:port:addr`。切分规则抄 curl 8.19.0 实测——**第一个冒号前=host，第二个冒号前=port，其余全是 addr**（所以 IPv6 的 `a.test:80:2001:db8::1` 里 addr=`2001:db8::1`，`a.test:80:[::1]` 里 addr=`[::1]`）。命中且合法才落进 `options.resolve`，**不再进 `rawArgs`**。单横线 `-resolve` **不是**合法别名（curl 把它当打包短选项 `-r esolve…`，实测报 "URL rejected: Port number was not a decimal"），故不认。

**非法值一律不结构化**：port 非数字、addr 写成主机名、IPv4 后多余段等，curl 都报 `curl: (49) Could not parse CURLOPT_RESOLVE entry`。所以 `parseResolveEntry` 判 `null` 时把原 token **原样留在 `rawArgs`**——宁可"这条没结构化、但粘回终端照样能跑（同样报 49，不改变原行为）"，也不要"结构化出一条我们替用户臆造的命令"。校验 IP 与否也只信 `parseResolveEntry` 这一个判据：`normalizeOptions` 不另写一套 validator，而是把 `{host,port,addr}` 重新拼成字符串再喂回它，避免两处漂移。

**已知限制**：IPv6 内嵌 IPv4 形式（`::ffff:1.2.3.4`）会被 `isIPv6` 判 false → 落 `rawArgs`（不结构化）。登记在案，将来若运维真用到再补。

**生成方向**：每条输出 `--resolve '<host>:<port>:<addr>'`（addr 里若带方括号，剥括号只用于校验，存储与生成**原样保留**以便逐字节往返），位置在 §4.1 输出顺序的"选项"段（`-x` 之后、headers 之前），多条按数组原序。`canonical` 用例钉住这个位置，Kotlin 照抄。同一 host 允许出现多条（不同 port），`resolve[]` 不归并。

**三条 round-trip 义务**（与 §3 同一套，均已过）：

1. parse→generate 逐字符相等（`fixtures/resolve.json` 的 canonical 用例）；
2. `parse(generate(parse(curl)))` 规范化后等于 `parse(curl)`（幂等，§3.3）；
3. 生成出的每条 `--resolve` 用真实 curl 对拍（`roundtrip.live`，含 `--resolve` 分片）。

**迁移兼容（读旧写新）**：`normalizeSpec` 会扫描 `rawArgs`，把其中 `--resolve x:y:z`（先剥成对引号）用 `parseResolveEntry` 验证——合法就提成 `options.resolve`、从 `rawArgs` 删掉；非法就原样留。所以旧集合文件 / 旧粘贴命令里的裸 `--resolve` 一打开就升级成新字段，不会"丢了那条 resolve"，生成侧也统一走新字段。

**实测结论**（原"待确认项"的落定）：

| 原待确认 | 实测结论（curl 8.19.0） |
|---|---|
| IPv6 `addr` 的确切切分 | 第二个冒号之后整段都是 addr；方括号可选，剥括号仅用于校验，存储/生成保留原样 |
| 同一 host 多条 `--resolve`（不同 port）是否都生效 | 都生效；`resolve[]` 允许重复 host，不裁剪 |
| `addr` 能否写成主机名 | **不能**（报 49），字段叫 addr 且"必须 IP"是对的 |
| 与 `--doh-url` / `--dns-servers` / `--interface` 的关系 | 本契约为**只做 `--resolve`**；其余留作同类扩展，M4a 不撑爆 options |

**fixture**：`fixtures/resolve.json` 共 6 条 canonical（单条 IPv4、多条、无括号 IPv6、带括号 `[::1]`、与 `-k`/`-x` 混排钉顺序、非法值 `x.test:80:notanip` 落 rawArgs 且 `resolve:[]`）。`contract.test.ts` 三条绊线随之更新：用例总数 79→85、文件数 6→7、文件名清单加 `resolve.json`。
