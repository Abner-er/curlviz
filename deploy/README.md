# CurlViz 生产部署（Linux ECS）

本套件把 CurlViz 部署到一台公网 Linux ECS，前端与 agent 同域（nginx 反代），浏览器同源直连免 CORS。

## 架构

```
浏览器 ──HTTPS──▶ nginx (ECS, 域名 + Let's Encrypt 证书)
                   ├─ /        → 静态 web/dist（PWA）
                   └─ /exec    → 反代 127.0.0.1:8788（agent 只监听本机）
agent ──spawn──▶ 真 curl ──▶ 你的内网目标（--resolve 在这里才生效）
```

**关键安全点**：agent 不直接暴露公网，只走 nginx 反代；token 鉴权 + SSRF 白名单 + 审计脱敏。

## 先选 TLS 模式

| 模式 | 命令 | 要域名? | 要梯子/备案? | 浏览器 | 适合 |
|---|---|---|---|---|---|
| **自签证书**（推荐内部工具） | `--self-signed --ip <ECS公网IP>` | 不要 | 都不要 | 首次点一次「继续访问」 | 没域名、内部运维、最快上线 |
| 受信证书（Let's Encrypt） | `--domain <域名>` | 要 | 大陆 ECS 要备案 | 无警告 | 有域名、要公网正式服务 |

**没域名就选「自签证书」**：openssl 自签一张证书，HTTPS 照样真加密（token 不被嗅探），PWA 的 service worker 也能注册；代价只是浏览器首次访问弹一次证书警告，点「高级 → 继续访问」即可，团队每人点一次。完全不用碰 DuckDNS / 梯子 / 备案。

### 自签证书一键部署（无域名）

```bash
git clone <your-repo-url> /tmp/curlviz
cd /tmp/curlviz
sudo bash deploy/install.sh --self-signed --ip <你的ECS公网IP>
# 不记得 IP 可省略 --ip，脚本会自动探测公网 IP（探测失败会提示你补 --ip）
```

脚本打印 `baseUrl=https://<ECS公网IP>` + token，填进前端「执行机管理」即可。安全组放行 **443**（自签走 IP 一般不触发大陆备案拦截；若 443 被拦，改非标端口见故障排查）。

> 自签证书有效期 10 年，不用续签。换 IP/域名后需 `rm /etc/curlviz/tls/*.pem` 再重跑脚本重新生成。

## 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| ECS | Linux（Ubuntu 20.04+ / Debian 11+ / CentOS 8+） | 需 root 权限 |
| 依赖 | node ≥ 20、curl、nginx、git、openssl | 脚本会检查；**certbot 仅受信证书模式需要** |
| 域名 | 仅受信证书模式需要 | 自签模式用 IP 即可，无需域名；受信模式没域名可用 DuckDNS 免费子域名（见下） |
| 端口 | 自签：443（可用 `--https-port` 换）；受信：80 + 443（固定） | 安全组/防火墙放行；被占时脚本预检会报错并给出出路（见「已有 nginx / 端口被占」节） |

## 已有 nginx / 端口被占？（兼容性）

**机器上已有 nginx、跑着别的站点**——完全兼容，不用停现有服务：

- 配置**增量**写入 `/etc/nginx/conf.d/curlviz.conf`（唯一文件名，已存在则不覆盖），**不碰**你现有的任何站点配置；
- 模板不抢 `default_server`，按 `server_name`（HTTP）/ SNI（HTTPS）路由，与现有站点在同一端口上互不干扰；
- 用 `reload` 平滑加载（nginx 已在跑时），现有站点**零停机**；nginx 装了但没启动时脚本会自动 `enable + start`；
- 脚本的端口预检会把「端口由本机 nginx 持有」判为**正常共存**，直接继续。

**80/443 被非 nginx 进程占用**（Apache、Caddy、docker-proxy 等）——脚本在复制代码/构建**之前**预检，报出占用进程名并给两条出路：

1. 停掉占用者（`systemctl stop <服务>` / `docker stop <容器>`）后重跑；
2. 换端口（仅自签模式）：`--http-port 8080 --https-port 8443`，浏览器访问 `https://<IP>:8443`，安全组放行 8443。nginx 监听、HTTP→HTTPS 跳转目标、`.env` 的 `CURLVIZ_ALLOWED_ORIGINS`、打印的 baseUrl 全部自动带端口。

> 受信证书模式固定 80/443——certbot 的 HTTP-01 验证走标准端口，换端口签不了证。要换端口请用自签模式。

**CentOS/RHEL 且 SELinux enforcing**：脚本会自动给 `web/dist` 打 `httpd_sys_content_t` 上下文（否则静态文件 403）；若 `/exec` 反代 502，需手动放行 nginx 网络连接：`sudo setsebool -P httpd_can_network_connect 1`（系统级安全策略，脚本不自动改）。

## 受信证书模式：没有域名？用 DuckDNS 免费子域名

> 仅「受信证书模式」需要域名。若你只是想免域名上线，直接用上面的**自签证书模式**即可，跳过本节。

certbot 签正经 TLS 证书必须有域名（裸 IP 签不了）。不想买域名就用 [DuckDNS](https://www.duckdns.org)——免费、用 GitHub/Google 账号登录即可、无需邮箱验证（注意：国内访问 DuckDNS 可能需要梯子；打不开就改用自签模式）：

1. 打开 https://www.duckdns.org ，用 GitHub / Google 账号登录；
2. 在 `sub domain` 框填一个名字（如 `mycurlviz`），点 `add domain`，得到 `mycurlviz.duckdns.org`；
3. 在 `current ip` 框填你的 **ECS 公网 IP**，点 `update ip`（这就是把子域名解析到 ECS）；
4. 部署时 `--domain mycurlviz.duckdns.org` 即可，certbot 正常签证书 + 自动续签。

> DuckDNS 的 IP 变了要手动 update（ECS 公网 IP 一般固定，不用管）。页面顶部那串 `token` 是 DuckDNS 自己的 API token，**与 CurlViz 的 token 无关**，别填错。

## 一键安装

```bash
# 1. 把整个项目复制到 ECS（git clone / rsync / scp 都行）
git clone <your-repo-url> /tmp/curlviz
cd /tmp/curlviz

# 2. 跑安装脚本（需 root）——二选一：
sudo bash deploy/install.sh --self-signed --ip <ECS公网IP>   # 自签，无域名
sudo bash deploy/install.sh --domain curlviz.example.com     # 受信，需域名
```

脚本会：
1. 检查依赖（node / curl / nginx / git / openssl；certbot 仅受信模式）+ 预检端口占用（被非 nginx 占用会报错并给出出路）
2. 复制代码到 `/opt/curlviz`（默认，可用 `--install-dir` 改）
3. `npm ci` 装依赖 + `vite build` 构建前端
4. 生成 `/etc/curlviz/.env`（含随机 token + 内网白名单）
5. 安装 systemd 服务 `curlviz-agent` 并启动
6. 配置 nginx 反代（`/exec` → agent，`/` → 静态文件）
7. TLS：自签模式 openssl 生成证书（10 年）；受信模式 certbot 签 Let's Encrypt + 自动续签

**幂等**：可重复跑，已存在的 `.env` / 证书 / nginx 配置不覆盖。

## 安装后

脚本最后会打印：

```
前端 baseUrl：https://curlviz.example.com
前端 token：  <随机 64 位 hex>
```

打开浏览器访问 `https://curlviz.example.com`，在「执行机管理」里填上面的 baseUrl 和 token。

## 手动配置

### 修改 SSRF 白名单

编辑 `/etc/curlviz/.env`：

```bash
# 只允许访问的内网段（逗号分隔）
CURLVIZ_ALLOW=internal.api,10.20.0.0/16,*.svc.cluster.local
```

**不要写 `0.0.0.0/0`**——等于没闸门。

修改后重启服务：

```bash
sudo systemctl restart curlviz-agent
```

### 修改 token

```bash
# 生成新 token
openssl rand -hex 32
```

编辑 `/etc/curlviz/.env`，替换 `CURLVIZ_TOKEN=` 后面的值，重启服务。前端需重新填 token（刷新页面后）。

### 查看日志

```bash
# agent 日志
sudo journalctl -u curlviz-agent -f

# nginx 日志
sudo tail -f /var/log/nginx/error.log
```

## 故障排查

### 服务启动失败

```bash
# 查看 systemd 状态
sudo systemctl status curlviz-agent

# 查看最近 50 行日志
sudo journalctl -u curlviz-agent -n 50 --no-pager
```

常见原因：
- `.env` 文件权限不对（应 `chmod 600`）
- 端口 8788 被占用（`sudo netstat -tlnp | grep 8788`）
- node 版本过低（需 ≥ 20）

### certbot 签证书失败

常见原因：
- 域名未解析到本机（`dig curlviz.example.com` 检查）
- 80 端口未放行（安全组/防火墙）
- nginx 配置错误（`sudo nginx -t` 检查）

手动重试：

```bash
sudo certbot --nginx -d curlviz.example.com --redirect
```

### 前端访问 502 Bad Gateway

agent 服务挂了或端口不对：

```bash
# 检查服务状态
sudo systemctl status curlviz-agent

# 检查端口
curl http://127.0.0.1:8788/healthz
```

若 agent 正常（healthz 通）但 nginx 仍 502，且系统是 CentOS/RHEL（SELinux enforcing）：SELinux 默认禁止 nginx 向外发起连接，放行：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

静态文件 403 则是上下文问题（脚本已自动 chcon，重跑可补）：`sudo chcon -R -t httpd_sys_content_t /opt/curlviz/web/dist`。

### 前端报 401 Unauthorized

token 不匹配：检查 `/etc/curlviz/.env` 的 `CURLVIZ_TOKEN` 与前端填的是否一致。

### 前端报 403 Forbidden

SSRF 白名单拒绝：检查目标地址是否在 `CURLVIZ_ALLOW` 里。

### 自签证书：浏览器弹「不安全 / 证书无效」

这是**预期行为**，不是故障——自签证书不被公共 CA 信任。点「高级 → 继续访问（不安全）」即可正常用，token 仍走 TLS 加密。团队每人首次点一次。

若想彻底消除警告：把 `/etc/curlviz/tls/cert.pem` 分发给团队，各自导入操作系统/浏览器的「受信任根证书颁发机构」即可（导入后该证书被本机信任）。

### 自签证书：大陆 ECS 的 443 被拦 / 端口被占

大陆云厂商可能拦 80/443（备案），或机器上已有别的服务占着端口。自签模式直接用 `--http-port` / `--https-port` 换非标端口，脚本会自动处理 nginx 监听、HTTP→HTTPS 跳转目标、`.env` 的 `CURLVIZ_ALLOWED_ORIGINS` 和打印的 baseUrl：

```bash
sudo bash deploy/install.sh --self-signed --ip <ECS公网IP> --http-port 8080 --https-port 8443
```

然后 baseUrl 填 `https://<ECS公网IP>:8443`，安全组放行 8443。**已部署过想换端口**：先 `sudo rm /etc/nginx/conf.d/curlviz.conf` 再带新端口重跑（配置幂等不覆盖），并按脚本提示同步 `.env` 的 `CURLVIZ_ALLOWED_ORIGINS` 后 `systemctl restart curlviz-agent`。

### 自签证书：换了 IP 后浏览器报 SAN 不匹配

证书的 SAN 钉死了旧 IP。删掉重生成：

```bash
sudo rm /etc/curlviz/tls/*.pem
sudo bash deploy/install.sh --self-signed --ip <新IP>
```

## 更新部署

代码更新后重新跑安装脚本即可（幂等）：

```bash
cd /opt/curlviz
sudo git pull
# 重跑时保持与原部署相同的模式：
sudo bash deploy/install.sh --self-signed --ip <ECS公网IP>   # 原来自签
sudo bash deploy/install.sh --domain curlviz.example.com     # 原来受信
```

脚本会：
- `git pull` 拉最新代码
- `npm ci` 重装依赖（如有变化）
- `vite build` 重新构建前端
- 重启 systemd 服务

**不会覆盖** `/etc/curlviz/.env`（保留你的配置）。

## 卸载

```bash
# 停止并禁用服务
sudo systemctl stop curlviz-agent
sudo systemctl disable curlviz-agent

# 删除 systemd 单元
sudo rm /etc/systemd/system/curlviz-agent.service
sudo systemctl daemon-reload

# 删除 nginx 配置
sudo rm /etc/nginx/conf.d/curlviz.conf
sudo nginx -t && sudo systemctl reload nginx

# 删除受信证书（仅受信模式；自签证书在 /etc/curlviz/tls，随下面 rm -rf /etc/curlviz 一并删除）
sudo certbot delete --cert-name curlviz.example.com

# 删除安装目录
sudo rm -rf /opt/curlviz

# 删除配置目录
sudo rm -rf /etc/curlviz
```

## 开发环境（Windows / macOS 本地）

开发时不需要 nginx / certbot，直接：

```bash
cd agent
npm start
# agent 监听 http://127.0.0.1:8788
```

前端 dev server（`npm run dev`）访问 `http://127.0.0.1:5183`，baseUrl 填 `http://127.0.0.1:8788`（跨源，需配 `CURLVIZ_ALLOWED_ORIGINS=http://127.0.0.1:5183`）。
