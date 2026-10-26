# CurlViz 方案定稿 v1

> **CurlViz**（中文名：**curl 可视化**，2026-10-26 定名；npm 包名 `@curlviz/core`）。一句话定位：**面向运维的可视化 curl 工具——curl 与表单双向互转，网页 PWA + 安卓 APK 双端，免登录、不过云、数据全本地。**

## 1. 已确认决策（2026-10-25）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 网页端执行 | 浏览器 fetch + 可选本地 agent | agent 为 Node 单文件零依赖，直接调系统 curl，天然信任本机 CA 与代理设置，执行结果与终端一致 |
| 安卓端执行 | OkHttp | 证书/代理自管，APK 自包含，不依赖设备上有 curl 二进制 |
| 安卓技术栈 | Kotlin + Jetpack Compose + Material3 | 同类项目（QueryQuill 等）同款栈，UI 迭代快 |
| 数据归属 | 全本地存储，无账户、无云同步、无遥测 | 运维数据敏感，这是硬约束也是产品差异点 |
| 不 fork 现有项目 | 自研，借鉴交互 | Hoppscotch 非 curl 中心改造量大；QueryQuill 只有单端且导入未完成。核心代码（解析器+生成器+表单状态）两边各几百行，可控 |

## 2. 目录结构（monorepo）

```
G:/AI_LLM/Curl/
├── docs/
│   ├── PLAN.md            # 本文件
│   └── curl-spec.md       # 契约规范（M0 从本文件附录拆出）
├── spec/
│   └── fixtures/*.json    # 契约测试用例，TS/Kotlin 两端共用
├── packages/
│   └── core-ts/           # TS：curl 解析/生成 + 变量替换 + 契约测试（npm 名 @curlviz/core）
├── web/                   # Vite + React 18 + TS，PWA
├── android/               # Kotlin + Compose（minSdk 24）
└── agent/                 # Node 单文件本地执行代理（M4）
```

## 3. CurlSpec 契约 v1（双端唯一事实源）

```json
{
  "version": 1,
  "name": "获取用户列表",
  "method": "GET",
  "url": "https://{{host}}/api/users",
  "query":  [{ "key": "page", "value": "1", "enabled": true }],
  "headers": [{ "key": "Authorization", "value": "Bearer {{token}}", "enabled": true }],
  "body": {
    "type": "none",
    "json": "",
    "form": [],
    "multipart": [],
    "raw": ""
  },
  "auth": {
    "type": "none",
    "basic": { "username": "", "password": "" },
    "bearer": { "token": "" }
  },
  "options": {
    "followRedirects": true,
    "insecure": false,
    "timeoutMs": 10000,
    "userAgent": "",
    "proxy": "",
    "compressed": true
  },
  "rawArgs": []
}
```

- `body.type`：`none | json | form | multipart | raw`
- `multipart[]`：`{ key, kind: "text|file", value, filename, contentType, enabled }`
- `rawArgs`：解析时无法识别的 curl 参数原样保留，生成时原样输出——**逃生通道，保证往返不丢数据**
- 变量语法：`{{name}}`，作用于 url/headers/body/auth 的全部字符串值；未解析的变量发送前高亮提示
- 集合文件格式：`{ format: "curlviz-collection", version: 1, environments: [...], requests: [...] }`

### curl 生成规则（表单 → 命令）

| CurlSpec 字段 | 输出 |
|---|---|
| method ≠ GET | `-X METHOD`（HEAD 走 `-I`，见 §8） |
| headers[] | `-H 'K: V'`，单引号包裹，值内 `'` 转义为 `'\''` |
| query[] | percent-encode 后拼入 URL |
| body=json | `--data-raw '...'`，未显式设置时自动补 `Content-Type: application/json` |
| body=form | `-d 'k=v&k2=v2'` |
| body=multipart | `-F 'k=v'` / `-F 'k=@path;type=...'` |
| body=raw | `--data-binary '...'` |
| auth=basic | `-u 'user:pass'` |
| auth=bearer | `-H 'Authorization: Bearer tok'` |
| followRedirects | `-L` |
| insecure | `-k` |
| timeoutMs | `--connect-timeout N` |
| userAgent | `-A '...'` |
| proxy | `-x '...'` |
| compressed | `--compressed` |

默认多行输出（行尾 ` \` 续行，两空格缩进），可在设置里切单行。复制到终端可直接运行。

### curl 解析规则（命令 → 表单）

- 先过 bash 风格分词器：处理单/双引号、`\` 转义、跨行续行、`#` 注释
- 覆盖 flag：`-X/--request`、`-H/--header`、`-d/--data/--data-raw/--data-binary/--data-urlencode`、`-F/--form`、`-G/--get`（把 data 转 query）、`-u/--user`、`-A/--user-agent`、`-b/--cookie`、`-e/--referer`、`-L/--location`、`-k/--insecure`、`--connect-timeout`、`-m/--max-time`、`-x/--proxy`、`-I/--head`、`--compressed`
- URL 自带 query 与 `-d`（配合 `-G`）合并进 `query[]`
- 识别 `$VAR` / 反引号命令替换：警告"含 shell 变量，解析结果不保证等价"，原文进 `rawArgs`
- 无法映射的 flag：进 `rawArgs`，不丢
- 解析失败：报错带 token 位置，表单保留已解析部分

## 4. v1 功能范围

**做**：表单编辑（方法/URL/query/headers/body 四类型/auth/常用开关）；curl 实时预览与复制；粘贴 curl 导入；发送与响应视图（状态码/耗时/大小/响应头/响应体，JSON 格式化，HTML·图片沙箱预览，原始视图）；collections + 环境变量 + 请求历史；JSON 导入导出 + 分享（安卓二维码 / 网页链接）；PWA 可安装；本地 agent（M4）。

**不做（v1 明确排除）**：GraphQL / WebSocket / SSE；pre-request 与 test 脚本；mock server；压测与批量运行；团队协作与云同步；桌面端；OAuth2 交互式授权（v2 评估）。

## 5. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 | CurlSpec 定稿 + core-ts（解析/生成/变量）+ 共享 fixtures 契约测试 | 地基，两端行为在这对齐 |
| M1 | Web MVP：表单 + 实时 curl + 粘贴导入 + fetch 发送 + 响应视图 + 本地持久化 | 浏览器可用的闭环 |
| M2 | Web 增强：collections / 环境变量 / 历史 / 导入导出 / 分享 | 可日常使用 |
| M3 | 安卓 MVP：Compose UI + OkHttp 执行 + Room 存储 + 复制分享 curl | APK 闭环 |
| M4 | 双端互通（JSON/二维码）+ 本地 agent + 打磨（快捷键、脱敏、时间分解） | 双端齐活 |

## 6. 风险与边界（提前排雷）

1. **curl 解析边界**：引号嵌套、续行、`--data @file`、`-G` 语义、短选项粘连——靠 `rawArgs` 逃生通道 + fixtures 覆盖，解析失败不丢数据。
2. **响应预览 XSS**：iframe sandbox + srcdoc 隔离，禁止 innerHTML；响应体超 512KB 截断并提示。
3. **安卓暗礁**：明文 http 需 network security config 放行；用户导入私有 CA 需信任配置——内网场景不处理这两项等于废掉，现有安卓工具普遍栽这。
4. **Web CORS 诚实提示**：对方无 CORS 头时浏览器发不了，界面明确说明并引导 agent / 复制到终端，不装能发。
5. **敏感信息**：历史与分享默认脱敏 Authorization/Cookie，可开关。
6. **agent 安全边界**：只监听 127.0.0.1，网页经 `http://127.0.0.1:<port>` 调用；M4 出简单 token 校验。

## 7. 待定项（不阻塞开工）

- ~~名字~~ ✅ 已定：**CurlViz**（中文：curl 可视化），2026-10-26
- 网页托管：v1 本地构建 + PWA，托管（CF Pages / GH Pages）M2 后评估
- agent 分发：先 `npx` 一行启动，后期打包单文件 exe
- 安卓 minSdk：暂定 24（Android 7.0，覆盖率约 95%+）

## 8. 实现期勘误（M0，2026-10-26）

写代码时发现 v1 的三处规定会导致**往返丢数据或命令跑不通**，已按下面的方式实现。
§4 的生成规则表以本节为准，逐条理由与字段语义写在 `spec/README.md` §9。

| # | 原表规定 | 实际实现 | 为什么要改 |
|---|---|---|---|
| 1 | `timeoutMs → --connect-timeout N` | `timeoutMs → -m`（总时限），**新增** `connectTimeoutMs → --connect-timeout` | curl 的两个 flag 语义不同：`-m` 管整条请求，`--connect-timeout` 只管建连。挤进同一个字段后，`curl -m 30` 导入会被生成成 `--connect-timeout 30`，建连成功后就再没有总时限——直接违反本文件"往返不丢数据"的硬约束 |
| 2 | 引号只有一套：`'` 包裹、值内 `'` 转成 `'\''` | 生成侧加 `quoteStyle: 'posix' \| 'windows'` | `'\''` 是 shell 语法，cmd.exe 不认。本机 curl 8.19.0 实测收到字面量 `''\''quick\'''`，POSIX 风格粘进 cmd 就是坏命令。Windows 必须能切 `"…"` + `\"` 那套 |
| 3 | `method ≠ GET → -X METHOD`（HEAD 也走这条） | HEAD 输出 `-I`；`-X HEAD` 导入时**被规范成 `-I`** | `-X HEAD` 只改请求行的方法名，curl 仍照 GET 的预期等一个永远不会来的响应体，命令看着像卡死（社区公认的坑）。`-I` 才是"HEAD 且不等 body"。`CurlSpec.method` 表达不了"等不等 body"这个区别，两端统一取不卡死的写法 |

第 3 条带来的连带规定：`-I` 与 `-X` 同时出现时（`curl -I url -X GET`），方法按 `-X` 取，
落选的 `-I` **不丢弃**，原样进 `rawArgs` 并给 `flag-conflict` 告警——否则重新生成只剩裸 `-I`，
方法会从 GET 悄悄翻回 HEAD。
