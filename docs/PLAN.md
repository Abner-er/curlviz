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
- `methodExplicit?`（M2.7 新增）：用户命令里是否**真写了** `-X`。隐式 POST（只有 `-d`）不许补 `-X POST`——
  实测 `-d … -L` 在 301 后降成 GET，`-X POST -d … -L` 却一路保持 POST，补上等于偷换请求语义。
  HEAD 是唯一把显式性丢掉的 case（`-X HEAD` 会死等响应体，生成侧永远输出 `-I`），留着会让往返第二次翻不上去。
- `query[].viaUrlQuery?`（M2.7 新增）：这一项来自 `--url-query`。生成时**仍逐条输出** `--url-query 'k=v'`、
  不折进 URL——curl 自己那张编码表跟 `encodeURIComponent` 不是一份（实测空格 → `+`、`!` → `%21`、`~` 原样）。
- `rawArgs`：解析时无法识别的 curl 参数原样保留，生成时原样输出——**逃生通道，保证往返不丢数据**
- 变量语法：`{{name}}`，作用于 url/headers/body/auth 的全部字符串值；未解析的变量发送前高亮提示
- 集合文件格式：`{ format: "curlviz-collection", version: 1, environments: [...], requests: [...] }`

下面两张表是**摘要**。逐条规则、实测依据、以及"跟 curl 已登记的差异"以
`spec/README.md` §4（生成）/ §5（解析）/ §10.1（差异登记）为准——M0 之后这两处已经漂过一回，
别再拿这里当细节源。

### curl 生成规则（表单 → 命令）

| CurlSpec 字段 | 输出 |
|---|---|
| method | HEAD → `-I`；其余看 `methodExplicit`：真写了 `-X`、或 curl 自己猜不出这方法时才输出 `-X METHOD`（隐式 POST **不补**，见 §8 与 `spec/README.md` §4.1） |
| headers[] | `-H 'K: V'`，单引号包裹，值内 `'` 转义为 `'\''`；值为空串输出 `-H 'K:'`（curl 里那是**删掉这个头**，实测）；同名不合并，线路上就是发两行 |
| query[] | percent-encode 后拼入 URL；`viaUrlQuery=true` 的行例外，输出 `--url-query 'k=v'` |
| body=json | `--data-raw '...'`，未显式设置时自动补 `Content-Type: application/json` |
| body=form | `-d 'k=v&k2=v2'` |
| body=multipart | `-F 'k=v'` / `-F 'k=@path;type=...'` |
| body=raw | `--data-binary '...'` |
| auth=basic | `-u 'user:pass'` |
| auth=bearer | `-H 'Authorization: Bearer tok'` |
| followRedirects | `-L` |
| insecure | `-k` |
| timeoutMs | `-m N`（总时限）；`--connect-timeout` 走 `options.connectTimeoutMs`，见 §8 勘误 1 |
| `-b` / cookie | 多个 `-b` 合成**一个** `-H 'Cookie: a=1; b=2'`，连接符是 `"; "`（实测 curl 就是这么发的），并按第一条 `-b` 的位置插入 |
| userAgent | `-A '...'` |
| proxy | `-x '...'` |
| compressed | `--compressed` |

默认多行输出（行尾 ` \` 续行，两空格缩进），可在设置里切单行。复制到终端可直接运行。

### curl 解析规则（命令 → 表单）

- 先过 bash 风格分词器：处理单/双引号、`\` 转义、跨行续行、`#` 注释
- 覆盖 flag（以 `parse.ts` 的 `MAPPED` 表为准）：`-X/--request`、`-H/--header`、
  `-d/--data/--data-ascii/--data-raw/--data-binary/--data-urlencode`、**`--url-query`**（M2.7 新增）、
  `-F/--form/--form-string`、`-G/--get`（把 data 转 query）、`-u/--user`、`-A/--user-agent`、`-b/--cookie`、
  `-e/--referer`、`-L/--location/--no-location/--location-trusted`、`-k/--insecure`、`--compressed`、
  `-I/--head`、`--connect-timeout`、`-m/--max-time`、`-x/--proxy`、`--url`
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
§4 的生成规则表以本节为准，逐条理由与字段语义写在 `spec/README.md` §10。

| # | 原表规定 | 实际实现 | 为什么要改 |
|---|---|---|---|
| 1 | `timeoutMs → --connect-timeout N` | `timeoutMs → -m`（总时限），**新增** `connectTimeoutMs → --connect-timeout` | curl 的两个 flag 语义不同：`-m` 管整条请求，`--connect-timeout` 只管建连。挤进同一个字段后，`curl -m 30` 导入会被生成成 `--connect-timeout 30`，建连成功后就再没有总时限——直接违反本文件"往返不丢数据"的硬约束 |
| 2 | 引号只有一套：`'` 包裹、值内 `'` 转成 `'\''` | 生成侧加 `quoteStyle: 'posix' \| 'windows'` | `'\''` 是 shell 语法，cmd.exe 不认。本机 curl 8.19.0 实测收到字面量 `''\''quick\'''`，POSIX 风格粘进 cmd 就是坏命令。Windows 必须能切 `"…"` + `\"` 那套 |
| 3 | `method ≠ GET → -X METHOD`（HEAD 也走这条） | HEAD 输出 `-I`；`-X HEAD` 导入时**被规范成 `-I`** | `-X HEAD` 只改请求行的方法名，curl 仍照 GET 的预期等一个永远不会来的响应体，命令看着像卡死（社区公认的坑）。`-I` 才是"HEAD 且不等 body"。`CurlSpec.method` 表达不了"等不等 body"这个区别，两端统一取不卡死的写法 |

第 3 条带来的连带规定：`-I` 与 `-X` 同时出现时（`curl -I url -X GET`），方法按 `-X` 取，
落选的 `-I` **不丢弃**，原样进 `rawArgs` 并给 `flag-conflict` 告警——否则重新生成只剩裸 `-I`，
方法会从 GET 悄悄翻回 HEAD。

## 9. 实现期勘误与新增约定（M2，2026-10-26）

§5 的 M2 只写了"collections / 环境变量 / 历史 / 导入导出 / 分享"这一行，落到代码上有四处**必须先定规矩**
否则安卓端 M3 无从对接、或者用户数据会静默丢失。这些是新增约定，不是推翻原表：

| # | PLAN 里的情形 | 实际定下的规矩 | 为什么必须现在定 |
|---|---|---|---|
| 1 | 只说"分享"，没说分享出去的是什么 | 定格式 `curlviz:1:` + 压缩标记（`g`/`p`）+ base64url，载荷 JSON 带 `kind`/`redacted`/`at`；压缩只用宿主原生 gzip；落地走 URL hash（`#share=`）；QR 阈值 1024 B 好扫 / 2600 B 上限。全文见 `spec/README.md` §9 | 分享码是**双端互通**的东西：网页生成的码 M3 安卓必须能扫开。现在不钉死，M3 就得反向猜 TS 的实现。另外"接个短链/二维码 API"能省很多代码，但那等于把内网接口地址交给第三方，与"不过云"直接冲突 |
| 2 | 只说脱敏，没说遮盖成什么样 | 遮盖**不留原文任何片段**（老写法留首尾各 3 位，已改掉） | M2 之前脱敏结果只在本地历史列表里看一眼，留头尾方便认是哪条凭据；M2 起它会**通过分享码离开本机**，长令牌留头尾就是白送熵片段 + 长度信息 |
| 3 | "环境变量"当成一个面板，没提版本 | M1 的扁平 `vars` 升级为多环境 `EnvState`，读取时先 sanitize；旧值启动时并进「默认」环境，**同名且值不同则保留环境里已有的值并把冲突名字显示给用户** | 冲突只能选一边：覆盖会把用户刚配好的生产值悄悄换掉，跳过会让旧数据凭空消失。"保留 + 报冲突"是唯一能被用户纠正的路径 |
| 4 | "导入导出"，没规定撞名怎么办 | 导入集合 / 恢复备份**一律新建、一律给新 id、重名自动加序号**，绝不按名字覆盖同名条目；比本端版本新的文件直接拒收而不是硬解 | 覆盖式导入在这类工具里的后果是"我导了个文件，昨天的集合没了"，不可撤销。新 id 同时避免了沿用的 id 和本地 `openRef`（编辑器正打开那条）串味 |

另外两条属于"故意不做"：

- **不做一键"清空全部环境/集合"**。这类按钮一次点击就不可恢复，而工具跑在用户本地、没有云端回收站。
  删除只做单条 + 两步确认（第一次点变成"再点一次确认删除"）。
- **不用 `window.alert/confirm`**。内联输入框和行内确认条，样式与 i18n 都可控，也不会被浏览器
  在 iframe / 全屏场景下静默拦掉。

仍待办（不假装做完）：M2 界面还没在真浏览器里人工点过一遍（这个环境没有浏览器自动化）；
`§7` 里"网页托管 M2 后评估"这件事还没做决定。

## 10. 界面重排与键盘可达性（M2.5，2026-10-26）

M1/M2 的界面是"功能一个个往上加"长出来的，两栏布局装下集合库 + 环境 + 导入导出 + 历史之后
已经开始互相抢地方。这一轮**不加功能、不加依赖**（不引 UI 组件库、不加路由、不装 jsdom），
只把结构理清，并修掉界面里几处会让人白忙的地方。

| # | 原来的毛病 | 改成 | 为什么这样改 |
|---|---|---|---|
| 1 | 两栏：左编辑右结果，集合库/环境/导入导出挤在右下角 | 三栏 shell：**资料库（左）/ 工作台（中）/ 结果（右）**，1440 与 1024 两档断点收栏 | 左栏是"跨请求的资产"，中栏是"这一条命令"，右栏是"这一次运行的结果"——三种时间尺度混在两栏里，找东西要靠滚 |
| 2 | curl 预览在右栏，改一个参数要跨过整个响应区去看命令 | 预览挪进中栏，紧跟编辑器 | 预览的对偶是编辑器，不是响应；这条也是"看起来还是那个界面"最容易退化回去的地方，已钉进 `App.smoke.test.tsx` 的 DOM 顺序断言 |
| 3 | 环境变量有两个入口（顶栏一个 select + 变量页签一个面板） | 只留资料库里「环境 · 变量」一处 | 同一件事两个入口，用户会怀疑它们是不是不同东西；且顶栏那个不告诉你在哪层生效 |
| 4 | 集合库找不着 = 等于没存 | 搜索框（集合名 / 请求名 / URL / 方法 / 启用的头名与参数名），命中部分请求时标「命中 3 / 12 条」并强制展开 | **不搜值**：值里多是凭据与环境数据，命中列表不是要找的东西，还会把 token 半截摊在屏幕上 |
| 5 | 页签只有 `aria-selected`，没 role 也没键盘；弹窗不管焦点 | `tablist/tab/tabpanel` + roving tabindex + 方向键/Home/End；分享弹窗 portal 到 body、开时落焦、关时交还、Tab 圈在弹窗内、背景 `inert` | 面板壳必须**始终渲染**：`aria-controls` 指着的 id 只在选中时存在就是悬空引用。`inert` 不支持的老浏览器退化成只有 Tab 圈定（背景还能点），不影响拿到分享链接，就不为它加更多代码 |

> **第 1 行当天就被推翻了**：资料库不占左栏，页面尽量留给工作区 —— 现在的形态见 §11。
> 第 3 行的原则留着、位置变了：改环境仍然只有一处入口，只是它进了抽屉，顶栏换成一枚**只读**读数。
> 第 2、4、5 行仍然成立，"为什么那样改"的推理对 M3 安卓端也有用，所以整段不删。

配套的三条纪律（不是界面，但这一轮才逼出来）：

- **换请求只有 `load()` 一个入口**。原先 `setActiveRef(NO_OPEN_REF)` 散在四处，漏一处的后果是
  从历史取回一条之后编辑器仍指着集合里那条，点「更新原条目」会覆盖一个无关请求。
- **从历史取回脱敏过的条目必须当场说一句**。拿 `••••••••` 当真凭据发出去，用户收到 401 只会
  怀疑接口坏了。判据收在 `lib/history.makeHistoryEntry` 里只判一次 —— 原先 `hasSensitive` 在
  **写入侧**被调了两遍（一遍决定存明文还是脱敏、一遍决定 `redacted` 标记），两处一旦漂移就会出现
  "存的是明文、标记写着已脱敏"的自相矛盾条目，而这种条目该不该提示、导出时该不该再遮全都跟着错。
- **落盘失败一律走 `usePersistence`**。草稿失败提示了、集合失败没提示，用户以为存上了。
  内存后端（隐私模式 / `file://`）不塌功能，只如实说一句。

仍待办：这一轮的界面**同样还没在真浏览器里人工点过**（本环境无浏览器自动化），dev 服务已起在
`http://localhost:5183/` 等验收；键盘路径（方向键切页签、Tab 圈在分享弹窗里、关弹窗焦点回原按钮）
尤其需要人眼确认一次——node 环境只测得出算术，测不出焦点。

## 11. 资料库改成右侧抽屉（M2.6，2026-10-26）

M2.5 落地后当天推翻第 1 行。理由是运维的实际动作：**九成的时间只在改一条命令**，
而"从库里挑一条"是一天一两次的事。为了一个低频动作常驻占掉左栏一整列（约 24rem），
等于让 URL 条与 curl 预览长期变窄。方向由此定为：**资料库不要放左边，页面尽量显示工作区，
粘贴 curl 改为弹窗**。

形态两处选了推荐项：**资料库 = 右侧抽屉**（整高、自己滚、按需叫出）；
**环境入口 = 顶栏留状态条**（只读读数 + 点进抽屉，改动仍然只有一处）。

| # | 这一轮定的事 | 细节 | 为什么 |
|---|---|---|---|
| 1 | 三栏改两栏 | `main` 只剩工作台 / 结果，断点收到 1100px 一档；结果栏接过"sticky + 自己滚" | 工作台比结果长，整页滚的话改参数时上一条返回就滚出视野了 |
| 2 | 资料库是抽屉，默认关 | `Overlay variant="drawer"` + `LibraryPanel`（三节：集合 / 环境·变量 / 导入导出，带吸顶跳转条） | 抽屉与内容拆两个组件不只为好看：Overlay 走 portal，服务端渲染器不认 portal，拆开之后 `LibraryPanel.test.tsx` 才测得到库里那三节 |
| 3 | 弹层外壳共用一份 | `components/Overlay.tsx` + `hooks/useModalShell.ts` + `lib/layers.ts`（叠放次序） | 抽屉里点「分享」是两层叠加。各写一遍 Escape 会一按全关；背景锁记布尔会在关里层时把外层的锁解掉。`layers` 只记顺序不碰 DOM，四条用例钉住 |
| 4 | 粘贴 curl 改弹窗 | `ImportDialog`（成功即关框，Ctrl+Enter 当场解析）；`useSend` 的全局 Ctrl+Enter 见到 `[role="dialog"]` 就不响应 | 否则这一次按键会把编辑器里那条旧命令一起发出去 |
| 5 | 顶栏补两枚线索 | 环境读数胶囊（虚线边，表示"只读"）+「资料库」按钮带 `N 集合 · M 请求` 徽章 | 库收起来之后的可发现性代价，只能靠徽章补；徽章用 `requestCount`，与抽屉标题同一算法，两处不许各算一遍 |

**认下来的三笔代价**（不是遗漏，是换的）：

- 库的可发现性下降 → 用徽章补，不靠"界面摆出来"。
- 粘贴导入成功后原文与表单不再同屏，"跟我原来那条差在哪"只能靠告警条与「选项」页里原样留下的
  flag 对照 → 写在 `ImportDialog` 的注释里。
- 抽屉里跳转要先开窗、等它把 DOM 造出来再滚（`libJump` 挂一次再清空），多一个状态位；
  平滑滚动得在调用点问一次 `prefersReducedMotion()`，样式表那条 `prefers-reduced-motion`
  管不住 JS 的 `scrollIntoView({behavior:'smooth'})`。

**本轮验证过的数字**（跑出来的，不是估的）：`npm run verify` 全绿 =
core 295（6 文件）+ web 230（18 文件），两个 workspace `tsc --noEmit` 零错；
`npm run build` 出 `index-DUbeUhn3.js` 260.68 kB（gzip 85.24）、`index-DrZ0ycVR.css` 8.01 kB
（gzip 2.37），二维码仍单独成 chunk（`browser-CqDbEFy1.js` 25.84 kB，动态 import 没退化）；
preview(4173) 与 dev(5183) 的 index、两个资源、lazy chunk 与本轮每个新增模块逐个 200。

**还没验的**：抽屉 34rem 这个宽度、吸顶栏约 5rem 与 `scroll-margin-top: 6rem` 的余量都是按字号推的，
**没在真浏览器里量过**；焦点走向（Tab 圈在抽屉内、关弹窗焦点回原按钮、叠两层按一次 Esc）
node 环境测不出来。dev 已起在 `http://localhost:5183/` 等人工点一遍。

## 12. 拿真实 curl 当裁判（M2.7，2026-10-27）

起因是三条待办挂了很久：**真实 curl 二进制往返对拍（posix vs cmd）**。自洽测试只能证明
"解析器和生成器互相没骗"，证明不了跟 curl 一致——结果这一轮跑出来的四处错，全部在自洽测试
**全绿**的情况下躲过了 M0/M1/M2 三轮。判据从此定死：**"复制到终端能跑，跑出来的请求和粘进来时一样"
才算对**，`spec/fixtures` 的期望值一律取自实测，不许凭记忆手写。

| # | 这一轮定的事 | 细节 | 为什么 |
|---|---|---|---|
| 1 | 对拍套件成为默认之外的第二道门 | `packages/core-ts/test/roundtrip.live.test.ts`，`CURLVIZ_LIVE=1` 才跑；进程内起 8080 回显 / 8081 重定向两个靶，跑完即关；比的是**请求行 + 全部响应头 + body** 的逐行字节 | 它要起服务、耗时 11.19s，塞进 `npm test` 会把快测拖成慢测，反而没人跑 |
| 2 | 每条用例三份读数，基线只有一条 | bash 跑原命令 = 基线；posix 列 = 生成命令再跑；windows 列 = cmd.exe 里跑 windows 引号版 | 两个 shell 的语义本来不同，混在一个"通过/失败"里就会拿 cmd 的理由放过 posix 的 bug |
| 3 | 差异表 `KNOWN` **按列**登记 | `get-plus-data` / `url-query-eq-empty` 两列都差，`json-shorthand` / `header-semicolon` 只在 cmd 差，`cookie-anchor-order` 两列都只差头序 | 允许"一条理由覆盖两列"就等于允许把真 bug 记成环境差异 |
| 4 | cmd 侧必须直传，不能走 `.cmd` 批处理 | `windowsVerbatimArguments: true` + `cmd /d /v:off /c`；`spawnSync` 会阻塞事件循环让靶子收不到请求，必须异步 | 批处理把 `-d "a=b%3Dc"` 的 `%3` 当位置参数吃掉，线上多出个 `D`；这个坑修好之后三条 data 用例自己转绿 |
| 5 | 四处按实测改写内核 | 多个 `-b` 合成**一个** Cookie 头、连接符 `"; "`，并按第一条 `-b` 的位置插入；同名 `-H` **不合并**（`dedupeHeaders` 删除）；新增 `methodExplicit`，隐式 POST **不补** `-X POST`；`--url-query` 解析进 `query[]` 并打 `viaUrlQuery`，生成时不折进 URL | 旧 Cookie 发成 `a=1,b=2` 是非法头形状；补 `-X` 会把 `-L` 的 301 行为从"降 GET"改成"保持 POST"；curl 的编码表把空格编成 `+`、`!` 编成 `%21`，跟 `encodeURIComponent` 不是一张表 |
| 6 | 书里的 20 条命令进契约，`canonical` 与 `parse-only` 分开标 | `spec/fixtures/book-curl.json`；canonical 的 `curl` 字段写的就是生成器那套多行规范形态（先倒进 `_wip/dump.json` 读输出，再抄） | 单行原写法永远对不上规范形态，硬凑 canonical 只会逼人把期望值改成实现——那正是这一轮要消灭的做法 |

**一句文档错话被实测推翻**：`spec/README.md` §4.4 原来写着"`-H 'K:'` 的 curl 语义是发空值头，不是删头"。
用 `net.createServer` 抓原始字节（`http.createServer` 会被 Node 的解析器提前吃掉请求块，抓不到）读数：
`-H 'Accept:'` 之后线路上**连 curl 自带的 `Accept: */*` 都没有了**；`-H 'User-Agent:'` 删 UA；
`-H 'Referer:'` 连 `-e` 给的 Referer 也删得掉；`-H 'X-Dup:' -H 'X-Dup: v'` 只发有值那一行；
而 `-H 'Acme;'` 发的是 `Acme:` ——**分号形态才是"发一行空值"**，那种形态我们建模不了，原样留 `rawArgs`。
改的顺序是先改文档、再让代码配得上文档：网页发送新增三条如实提示（删头做不到 / `rawArgs` 不执行 /
`--url-query` 编码表不同），query 表给 `--url-query` 来的项加胶囊，headers 表给空值头加「删头」胶囊，
headers 的 placeholder 从"留空 = 发空头"改成"留空 = `-H 'K:'`，curl 是删掉这个头"。
判据放在 `lib/display.ts` 的纯函数里（`queryRowNote` / `headerRowNote`），组件只画结果——web 层一贯分工。

**登记不修的五条差异**写进 `spec/README.md` §10.1（现象 / 为什么不立刻改 / 什么情况下必须改）：
`rawArgs` 存 bash 引号原文导致 cmd 下值泄漏（要修得把 `rawArgs` 结构化，契约 v2）、
`--url-query x` 与 `x=` 分不出来（同样 v2）、`-G` 时 curl 丢掉 `--url-query` 而我们不模仿、
Cookie 头序主动换成"跟命令顺序"、fetch 路径天生表达不了删头与 curl 编码表。
判断标准只有一条：**能被用户撞到的差异必须写下来，"看起来没差异"不是证据**。

**本轮验证过的数字**（跑出来的，不是估的）：对拍 45 条 = 40 条两列全同 / 3 条两列均已登记 / 2 条仅 cmd 列已登记，
未登记差异 0 条，耗时 11.19s；`npm run verify` 全绿 = core 350 passed + 1 skipped（7 文件，skip 的就是对拍）
+ web 240 passed（19 文件），两个 workspace `tsc --noEmit` 零错；fixture 79 条、其中 canonical 47 条；
`npm run build` 通过（118 模块，`index-ScLe5wry.js` 263.54 kB / gzip 86.31、`index-CtuVLELi.css` 8.13 kB / gzip 2.40，
二维码仍独立成 chunk `browser-CqDbEFy1.js` 25.84 kB）。

**还没验的**：网页 `fetch` 路径本身没进自动化（vitest 是 node 环境、没有 jsdom），上面那三条提示是
字符串层面的断言，浏览器里怎么摆、`-H 'K:'` 发出去到底长什么样，还得人工看一次——M2/M2.5/M2.6 三轮的
界面验收一并挂在 dev 服务 `http://localhost:5183/` 上等点击。`methodExplicit` / `viaUrlQuery` 两个新字段
目前只有 TS 端消费，Kotlin 端要等 M3 才能验"照文档就能实现"这句话；cmd 下 `rawArgs` 泄漏单引号是**已确认的
真缺陷**，这一轮只留下了对拍证据，没给修法。
