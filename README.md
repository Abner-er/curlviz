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
npm run dev                       # web 开发服务器
npm run build                     # 构建
npm run verify                    # typecheck + test
```

## 当前进度

| 阶段 | 状态 |
|---|---|
| M0 契约 + 内核 | ✅ 59 条 fixture、275 个测试全绿，严格 TS 无错 |
| M1 Web MVP | 进行中 |
| M2 Web 增强（集合/环境/历史/导入导出/分享） | 未开始 |
| M3 安卓 MVP | 未开始 |
| M4 双端互通 + 本地 agent | 未开始 |

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
