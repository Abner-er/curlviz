# CurlViz agent（M4c）

跑在**你自己的机器**上，替前端执行真 curl。前端把一条 spec 用 `POST /exec` 发过来，
agent 用 `spawn('curl', argv, {shell:false})` 跑它，把响应按 wire 契约（`spec/README.md §13`）
回给前端。数据不过第三方云：执行发生在你指定的这台机器上。

> 为什么要有它：`--resolve` 把域名钉到指定 IP 这类 flag，浏览器的 `fetch` 根本表达不了
> （`spec/README.md §10.1 #5`），只有真 curl 能跑。远程执行把它交给你的机器执行。

## 现在能做什么 / 还不能做什么（诚实边界）

- ✅ 已实现且本机测过：wire 编解码、IP/CIDR 位运算、SSRF 白名单闸门、curl 输出归一、
  HTTP 外壳（token / Origin / 契约 / 限流 / 请求体上限 / 脱敏审计）、拒绝路径的实机 HTTP 测。
  本机 `agent` 单测 95 passed / 8 files、`tsc --noEmit` 0 错误。
- ✅ `runCurl` 成功路径已在真机验（M4d，Termux/Alpine aarch64、curl 8.14.1）：
  用 curl **`-i`** 把响应头与体收在**同一条 stdout**，按首个空行内存切分（`splitHeadBody`）——
  不碰 fd、不写盘，Linux 与 Windows 的 curl 行为一致（旧 `--dump-header fd://3` 已**实测证伪**：
  curl 8.14.1 把入参当字面文件名，`fopen("fd://3")` 失败、退出码 23）。真机 `/exec` 打本地 echo
  返回 `ok:true`/200、headers 解析自 `-i` 流、body base64、`totalBytes` 精确、末尾 `-m` 封顶生效。
- ❌ v1 拒绝跟随重定向（`-L/--location`）：重定向后的目标在发请求前定不下来，SSRF 白名单管不住。
  要测会跳转的地址，请关掉"跟随重定向"、把最终地址单独发一条。

## 本地起服务（开发）

```bash
cd agent
CURLVIZ_TOKEN=随便一个长随机串 \
CURLVIZ_ALLOW=internal.api,*.svc.cluster.local,10.0.0.0/8 \
CURLVIZ_ALLOWED_ORIGINS=https://你的前端域名 \
npm start          # = vite-node src/main.ts（运行入口；server.ts 现为纯库不自启），默认端口 8788
```

探活（不触发 curl）：

```bash
curl http://127.0.0.1:8788/healthz
```

## 配置（全部走环境变量，没配 = 安全默认，不是全放行）

| 变量 | 默认 | 作用 |
|---|---|---|
| `CURLVIZ_PORT` | `8788` | 监听端口 |
| `CURLVIZ_TOKEN` | 空（不校验） | 唯一安全边界。设了就必须逐字匹配 `X-Curlviz-Token`；留空表示"前面有 OIDC/mTLS 反代代管鉴权" |
| `CURLVIZ_ALLOWED_ORIGINS` | 空（不校验） | Origin 白名单（逗号分隔，小写精确匹配）。配合自定义头触发的预检，挡 CSRF / DNS-rebinding |
| `CURLVIZ_ALLOW` | 空（一切默认拒） | 目标 allowlist（逗号分隔）。四种写法：主机名 `internal.api`、通配 `*.svc`、IP `10.0.0.5`、CIDR `10.0.0.0/8` |
| `CURLVIZ_MAX_TIME_MS` | `60000` | 单条 curl 墙钟上限（换算成 `-m` 秒数，末尾追加确保封顶） |
| `CURLVIZ_MAX_PREVIEW_BYTES` | `524288` | 响应体保留上限，超出截断（`truncated=true`、`sizeExact=false`），对齐前端 |
| `CURLVIZ_MAX_BODY_BYTES` | `1048576` | `/exec` 请求体上限 |
| `CURLVIZ_MAX_CONCURRENCY` | `8` | 同时在跑的 curl 进程数 |
| `CURLVIZ_RATE_PER_MIN` | `30` | 每分钟请求数（滑动窗口；拒绝请求也计数） |

## 安全模型

1. **Origin**（配了才校验）→ 2. **token**（配了就必须匹配，常量时间比较）→ 3. **请求契约**
   （只认 `v:1`、`spec` 是对象、`url` 非空）→ 4. **构造 argv**（`buildArgv`，不拼 shell 字符串，
   注入面由逐 token 构造消除）→ 5. **SSRF**：扫**最终 argv + url**（连 `rawArgs` 里的
   `--resolve`/`--connect-to`/`proxy`/`doh` 一起收），先无条件硬禁云元数据
   （`169.254/16`、阿里 `100.100.100.200`、`0/8`、`fe80::/10`、`fc00::/7`），再默认拒白名单 →
   6. **限流**（速率 + 并发 + 请求体上限）→ 7. 起 curl。

凭据（basic / bearer / Cookie 头 / proxy 用户名密码）经 `--config -` 走 **stdin**，不进 `ps`。
红线：**绝不落盘请求体与响应体**，只留脱敏审计（谁 / 何时 / 目标 host / 结果 / 耗时，不含路径 query 与任何 body）。

### 残留风险（诚实列出）

- **allowlisted 主机名的 DNS 再绑定**：对纯主机名目标，agent 不自己做 DNS，curl 解析后可能落到
  元数据/内网 IP。缓解：allowlist 收窄到确需的主机名、配合 `/etc/hosts` 钉死，或用 `--resolve`
  显式指定 IP（那种 IP 会被硬禁+白名单双重判）。彻底防需在连接层做 post-DNS 校验，非 v1 范围。
- **v1 不跟随重定向**（见上），正是为了不让目标在判后跳走。
- token 是唯一边界时（`allowedOrigins` 空），务必让 token 足够长且随机，并把 agent 放在可信网络内。

## 生产部署建议

- **同源反代 + TLS**：把 web（PWA）与 agent 挂在同一个主机名下（如 `/exec` 反代到本 agent 端口），
  浏览器同源直连、**免 CORS**。nginx 片段：

  ```nginx
  location /exec {
      proxy_pass http://127.0.0.1:8788;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header Origin $http_origin;
  }
  ```

- **生成 token**：`openssl rand -hex 32`，填进 `CURLVIZ_TOKEN`。前端"执行机管理"里填同一 token
  （token 只存会话内存，刷新需重填——见决策②）。
- **常驻**：`systemd` 服务 `ExecStart=... vite-node src/main.ts`（或经 `tsc` 产物 `node dist/main.js`），
  配 `Restart=always`。进程内不写业务数据，崩了直接重起无损。
- **放行走内网**：`CURLVIZ_ALLOW` 只加你真正要测的段（例：`10.20.0.0/16,api.svc`），不要图省事写 `0.0.0.0/0`。
