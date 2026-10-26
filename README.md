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
| M0 契约 + 内核 | ✅ 59 条 fixture、289 个测试全绿，严格 TS 无错 |
| M1 Web MVP | ✅ 导入/表单/双向转换/发送/响应预览/本地持久化，63 个测试全绿（含首屏冒烟），`vite build` 通过；剩下浏览器里的人工验收 |
| M2 Web 增强（集合/环境/历史/导入导出/分享） | 未开始 |
| M3 安卓 MVP | 未开始 |
| M4 双端互通 + 本地 agent | 未开始 |

## M1 在浏览器里做不到的事（不是 bug，是 fetch 的语义边界）

浏览器发请求用的是 `fetch`，与 curl 不是同一套规矩。这些差距界面会逐条列出来（「这次发送的注意点」），
而不是静默糊过去；真要 1:1 复现 curl，走「复制到终端」或 M4 的本地 agent。

| curl 能力 | 浏览器里的实情 | 兜底 |
|---|---|---|
| `-H 'Cookie: …'`、`Host`、`Origin`、`Referer`、`Content-Length` 等 | Fetch 标准里的 forbidden header，**会被浏览器悄悄丢掉**，脚本设了也不发 | 复制到终端 |
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

细节与理由写在 `spec/README.md` §9。
