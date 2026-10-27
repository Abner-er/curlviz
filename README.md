# CurlViz — curl 可视化

面向运维的可视化 curl 工具：**curl 命令 ⇄ 表单双向互转**，网页 PWA + 安卓 APK 双端，
免登录、不过云、数据全本地。

方案定稿见 [`docs/PLAN.md`](docs/PLAN.md)，跨端契约见 [`spec/README.md`](spec/README.md)。

## 目录

```
docs/PLAN.md              方案定稿（决策、范围、里程碑、风险）
spec/                     CurlSpec 契约 + fixtures（TS / Kotlin 双端唯一事实源）
packages/core-ts/         @curlviz/core：分词 / 解析 / 生成 / 变量 / 集合（浏览器与 Node 双 usable）
web/                      @curlviz/web：Vite + React 18 + TS，PWA
android/                  （M3）Kotlin + Compose + OkHttp + Room
agent/                    （M4）Node 单文件本地执行代理
```

## 常用命令

```bash
npm install                       # 工作区安装（本机 npm cache 在 H 盘会报 lstat 错，用下面这条）
npm install --cache 'G:\AI_LLM\.npm-cache'

npm run typecheck                 # 各包 tsc --noEmit
npm test                          # 各包 vitest run
npm run test --workspace @curlviz/core   # 只跑契约
npm run dev                       # web 开发服务器 http://localhost:5183
npm run build                     # 构建（含 tsc --noEmit）
npm run preview --workspace @curlviz/web   # 预览已构建产物 http://localhost:4173
npm run verify                    # typecheck + test
```

## 怎么打开

`dist/index.html` **双击打不开**：入口是 ES module，浏览器在 `file://` 下按 CORS 规则直接拒绝加载，
看到的就是一张白屏（不是构建坏了）。本地起个 HTTP 服务再打开：

```bash
npm run dev                                    # 改代码用，http://localhost:5183
npm run build && npm run preview --workspace @curlviz/web   # 看成品用，http://localhost:4173
```

`localhost` 是安全上下文，PWA 安装与 Service Worker 注册只在 http/https 下生效；
纯离线自用的话，`web/dist/` 整个拷进内网静态服务器（nginx / IIS / `python -m http.server` 都行）即可，
构建产物用的是相对路径。

## 当前进度

| 阶段 | 状态 |
|---|---|
| M0 契约 + 内核 | ✅ 79 条 fixture（47 条走完整往返）、core 350 个测试全绿，严格 TS 无错 |
| M1 Web MVP | ✅ 导入/表单/双向转换/发送/响应预览/本地持久化，含首屏冒烟；`vite build` 通过 |
| M2 Web 增强（集合/环境/历史/导入导出/分享） | ✅ 代码与测试完成（现状口径 web 269 + core 350，typecheck 干净，产物已实测可访问）；剩下浏览器里的人工验收 |
| M2.7 拿真实 curl 当裁判 | ✅ 45 条命令逐字节对拍 + 20 条书中命令进契约 + 4 处按实测改写；差异登记在 `spec/README.md` §10.1 |
| M2.8 跨域预检判定 | ✅ 发送前提醒 + 失败定向 hint + headless Chrome 页面级探针；只动网页端，`CurlSpec` 与 fixtures 未变 |
| M3 安卓 MVP | 未开始 |
| M4 双端互通 + 本地 agent | 未开始 |

## M2 多了什么

- **集合**：请求按集合存本地，编辑后再存回原条目（靠 id 认，不靠数组下标）；导出为
  `curlviz-collection` JSON（这就是跨端契约里的那个格式，安卓能读）。
- **多环境变量**：一个"当前环境"生效、其它环境兜底；面板会指出某个 `{{var}}` 到底是谁给的、
  还是根本没被覆盖。M1 的扁平变量在启动时自动并进「默认」环境。
- **导入 / 导出**：拖文件、选文件、粘贴文本三条路都通；curl 原文、集合 JSON、分享码、备份文件
  自动分辨。**导入一律新建并给新 id、重名加序号，绝不覆盖同名条目**。
- **分享**：请求或整个集合编成 `curlviz:1:…` 一段文本，本地 gzip + base64url（原生
  `CompressionStream`，不接任何第三方），生成链接（走 URL hash，不进服务端日志）或本地二维码。
  超过 2600 字节只给链接——那个密度的码手机扫不出来。
- **备份**：`curlviz-backup` 一次导出全部集合 + 环境（**网页端私有格式，不进跨端契约**，见
  `spec/README.md` §11）。

几个跟"东西会离开这台机器"有关的地方，值得先看清（默认值都是按这个取向定的）：

1. **分享弹窗永远默认勾着脱敏**，而且"带上环境变量"默认**不勾** —— 环境里的值不受脱敏管辖
   （遮了环境值，对方拿到的集合就用不了），所以勾上它会出整段红字提示。
2. **请求 / 集合导出**跟着"历史脱敏"那个开关走，默认开。
3. **完整备份默认不脱敏**：脱敏过的备份没法拿来恢复自己的密码，等于废文件；
   所以它按明文导出并在界面上写明"里面有明文 token / 密码，请按密码对待这个文件"。要共享就勾脱敏。
4. M2 的界面（集合面板、环境面板、分享弹窗、拖拽导入）**还没在真浏览器里逐一点过**——
   逻辑层有 269 条测试兜着（本轮实测），另有一条 headless Chrome + CDP 的页面级探针
   （见下一节，脚本放在仓库里被 gitignore 的 `_wip/` 下，故意不入库）能确认"提醒真的画到了页面上"；
   视觉与交互仍需你自己开 `npm run dev` 过一遍。

## M2.7 做了什么：拿真实 curl 当裁判

"解析器和生成器互相印证"只证明自洽，证明不了跟 curl 一样。这一轮把裁判换成 curl 本身。

- **对拍套件** `packages/core-ts/test/roundtrip.live.test.ts`：进程内起两个靶（8080 回显 / 8081 重定向），
  45 条命令打上去，抓**请求行 + 全部响应头 + body** 逐行比字节。每条三份读数：bash 里跑原命令 = 唯一基线，
  posix 列 = 重新生成的命令再跑，cmd 列 = cmd.exe 里跑 windows 引号版；差异表 `KNOWN` 按**列**登记，
  同一用例不许拿一个理由同时放过两列。`npm test` 默认不跑它（要起服务、秒级耗时），
  `CURLVIZ_LIVE=1 npx vitest run --root packages/core-ts` 才跑，报告落 `_wip/roundtrip-report.md`。
  本轮读数：40 条两列全同、3 条两列都已登记差异、2 条仅 cmd 列已登记差异，未登记差异 0 条。
- **四处按实测改写**（都是先跑出读数、再改代码，不是反过来）：多个 `-b` 合成一个 Cookie 头且连接符是 `"; "`
  （旧实现逗号拼接，线上 `a=1,b=2` 是非法形状，服务端直接不认）；同名 `-H` 不合并（实测就是发两行）；
  新增 `methodExplicit`，隐式 POST 不再补 `-X POST`（`-d … -L` 在 301 后降成 GET，补了 `-X` 就一路 POST）；
  `--url-query` 真的解析进 `query[]` 并打标记，生成时不折进 URL（curl 那张编码表跟 `encodeURIComponent` 不是一份）。
- **契约扩充**：从《学习 curl》挑 20 条命令进 `spec/fixtures/book-curl.json`，期望值全部取自实测输出；
  fixture 总数 79 条、其中 47 条走完整往返。安卓端（M3）照这份契约实现，读的就是这些文件。
- **推翻并改掉一句文档错话**：`spec/README.md` §4.4 原来写"`-H 'K:'` 是发空值头，不是删头"——实测是**删头**，
  而且连 curl 自带的 `Accept` / `User-Agent` 都删得掉；`-H 'K;'` 才是发一行空值。文档改对之后，
  接着让代码配得上这句话：网页发送新增三条如实提示（删头做不到、`rawArgs` 不执行、`--url-query` 编码表不同），
  表格里给 `--url-query` 来的项和值为空的头各加一枚语义胶囊。
- **一条仍知的缺陷，登记不藏**：`rawArgs` 存的是 bash 引号原文，切到 windows 风格时原样吐出单引号，
  cmd.exe 不认 → `--json '{"a":null}'`、`-H 'foo;'` 的值会漏。干净修法是把 `rawArgs` 结构化，那是契约 v2、
  要动 Kotlin 端和所有已存集合文件，所以先登记在 `spec/README.md` §10.1 第 1 行。

## M2.8 跨域这条路：把能算的算出来（2026-10-27）

用户在页面里发 `https://token.sensenova.cn/v1/chat/completions`，控制台报
`Response to preflight request doesn't pass access control check: It does not have HTTP ok status`。
原先界面只有一句"分不清是被 CORS 拦了、服务不通、还是证书不受信"——那句话没错，但把**能算的部分**也一起推给了用户。

- **不能算的是服务器答不答应，能算的是预检要不要发**：方法是否超出 GET/HEAD/POST、请求头是否在
  Accept / Accept-Language / Content-Language 之内、Content-Type 是否是那三个安全值，全是 Fetch 标准里的死规则。
  于是判据做成纯函数 `web/src/lib/fetch-rules.ts`（`assessCors`），组件只画结果。
- **本机实测那颗网关**（2026-10-27 01:29 UTC，curl 直接打）：带标准预检头的 `OPTIONS` 回 **404**，
  响应里**没有** `Access-Control-Allow-Methods` / `Allow-Headers`；同一路径 `POST` 回 **401**，却带着
  `Access-Control-Allow-Origin` 回显来源。也就是**跨域支持只做了响应头那半截，预检那半截没实现**——
  浏览器这条路必然走不通，跟命令对不对无关。这类接口不少见，所以提醒要提前给。
- **发送前就提醒**：curl 预览区下面直接写明"到哪个 origin 是跨域、会被先打一个 OPTIONS 预检、触发点是
  哪几项"，并指出出路是「复制到终端」（M4 的本地 agent 同样能发）。简单请求（不预检但仍跨域）另有一句：
  多半发得出去，但对方不回 `Access-Control-Allow-Origin` 时**响应体照样读不到**。
- **失败后按判定给定向 hint**：预检型直接引用浏览器原话（`doesn't pass access control check` /
  `It does not have HTTP ok status`）并说清那句对应什么；判不出来（同源、URL 还没填）时保留原来那句"分不清"，
  不硬编成 CORS。`-A` 的旧提醒在跨域判定成立时不再重复立一条——`user-agent` 已经作为触发点写进那句里了。
- **提醒得先替换变量再判**：URL 写着 `{{host}}/v1/chat` 时 origin 根本解析不出来，`preSendNotices()` 里
  先跑一遍 `resolveSpec`；变量没赋值就保持沉默，判不出来不瞎提醒。
- **页面级验证**：headless Chrome + CDP 探针（起调试端口 → 把跨域命令写进 `curlviz.draft` → 重载 → 读
  `document.body.innerText`）6 条断言全 PASS：提醒在预览区出现、点名 `Content-Type: application/json`、
  报出目标 origin、给出「复制到终端」、等价 curl 仍渲染。顺带发现 `innerText` 会带上 CSS 的
  `text-transform`，卡片标题读回来是「等价 CURL」。
- **只动网页端**：这是浏览器独有的边界，`CurlSpec` 一个字段没改，跨端契约与 fixtures 不动；
  安卓端（M3）用 OkHttp，压根没有 CORS 这件事。
- 本轮实测：typecheck 0 错，core 350 passed + 1 skip（不变），web **269 passed**（新增 29 条：
  `fetch-rules.test.ts` 16 条、`CurlPreview.test.tsx` 3 条、`http.test.ts` 6 条、`display.test.ts` 4 条），
  `vite build` 119 模块、产物 266.63 kB（gzip 87.52），CSS 11.08 kB 未变。

## M1 在浏览器里做不到的事（不是 bug，是 fetch 的语义边界）

浏览器发请求用的是 `fetch`，与 curl 不是同一套规矩。这些差距界面会逐条列出来（「这次发送的注意点」），
而不是静默糊过去；真要 1:1 复现 curl，走「复制到终端」或 M4 的本地 agent。

| curl 能力 | 浏览器里的实情 | 兜底 |
|---|---|---|
| `-H 'Cookie: …'`、`Host`、`Origin`、`Referer`、`Content-Length` 等 | Fetch 标准里的 forbidden header，**会被浏览器悄悄丢掉**，脚本设了也不发 | 复制到终端 |
| `-H 'K:'`（curl 里是**删掉这个头**，实测连自带的 `Accept` / `User-Agent` 都删得掉） | fetch 没有"删头"这个操作：自定义头会带着空值发出去，forbidden 头是整个忽略——两种都不是"不发这行" | 复制到终端 |
| `--url-query 'k=v'` 由 curl 自己编码（实测空格 → `+`、`!` → `%21`） | 浏览器发送只能把它折进 URL，编码用 `encodeURIComponent`（空格 → `%20`），两份字节可以不同 | 复制到终端仍逐条写 `--url-query` |
| 想发什么就发什么（跨域也一样） | 跨域时浏览器按 Fetch 标准**先打 OPTIONS 预检**（方法超出 GET/HEAD/POST、非安全清单头、`Content-Type: application/json` 都触发）；对方网关没实现 OPTIONS 路由就整条必死。工具现在发送前就算出触发点并写在预览区 | 复制到终端 / agent（M4） |
| 跨域读全部响应头 | CORS 只暴露 6 个安全头，其余读不到；界面会标「(受限)」 | F12 看原始响应 |
| `-k` 跳过证书校验 | 不可关。内网自签证书必须先让系统信任 | 系统信任链 / agent |
| `-x` 指定代理 | fetch 不能指定代理，只能跟随系统设置 | 系统代理 / agent |
| `--connect-timeout` 建连超时 | 只有总时限（`-m`）生效 | agent |
| `-F 'k=@本地文件'` | 网页读不到任意本地路径，文件字段跳过、只发文本字段 | 手动选文件 / agent |
| Digest / NTLM 认证 | fetch 不支持，只有 Basic、Bearer 能拼 | 终端 curl |
| https 页面发 http 目标 | 混合内容直接被拦，发送前就短路报错 | 用 http 打开本页（本地工具本就在内网） |

## M0 的三处契约偏离（待确认）

1. `options.timeoutMs` 生成 `-m`（总时限），新增 `options.connectTimeoutMs` 生成 `--connect-timeout`。
   PLAN 原表把两个 flag 都映射进 `timeoutMs`，会让 `curl -m 30` 变成 `--connect-timeout 30`，
   建连后不再受总时限约束——违反 PLAN 自己的"往返不丢数据"。
2. 生成侧新增 `quoteStyle: 'posix' | 'windows'`。`'\''` 是 shell 语法，cmd.exe 不认
   （本机 curl 8.19.0 实测收到字面量 `''\''quick\'''`），Windows 用户必须能切双引号风格。
3. HEAD 的规范输出取 `-I` 而不是 `-X HEAD`，`-X HEAD` 进来被规范成 `-I`。
   两者请求行相同，但 `-X HEAD` 只改方法名、curl 仍等一个永远不会来的响应体，命令看着像卡死。
   `CurlSpec.method` 表达不了"等不等 body"，所以统一取不卡死的写法。

细节与理由写在 `spec/README.md` §10。
