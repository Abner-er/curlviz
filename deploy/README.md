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

## 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| ECS | Linux（Ubuntu 20.04+ / Debian 11+ / CentOS 8+） | 需 root 权限 |
| 依赖 | node ≥ 20、curl、nginx、certbot、git | 脚本会检查 |
| 域名 | 已解析到 ECS 公网 IP | certbot 签证书必须用域名，裸 IP 签不了正经证书；**没域名可用 DuckDNS 免费子域名，见下** |
| 端口 | 80（HTTP，certbot 验证用）、443（HTTPS） | 安全组/防火墙放行 |

## 没有域名？用 DuckDNS 免费子域名

certbot 签正经 TLS 证书必须有域名（裸 IP 签不了）。不想买域名就用 [DuckDNS](https://www.duckdns.org)——免费、用 GitHub/Google 账号登录即可、无需邮箱验证：

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

# 2. 跑安装脚本（需 root）
sudo bash deploy/install.sh --domain curlviz.example.com
```

脚本会：
1. 检查依赖（node / curl / nginx / certbot / git）
2. 复制代码到 `/opt/curlviz`（默认，可用 `--install-dir` 改）
3. `npm ci` 装依赖 + `vite build` 构建前端
4. 生成 `/etc/curlviz/.env`（含随机 token + 内网白名单）
5. 安装 systemd 服务 `curlviz-agent` 并启动
6. 配置 nginx 反代（`/exec` → agent，`/` → 静态文件）
7. certbot 签 TLS 证书 + 自动续签

**幂等**：可重复跑，已存在的 `.env` 不覆盖。

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

### 前端报 401 Unauthorized

token 不匹配：检查 `/etc/curlviz/.env` 的 `CURLVIZ_TOKEN` 与前端填的是否一致。

### 前端报 403 Forbidden

SSRF 白名单拒绝：检查目标地址是否在 `CURLVIZ_ALLOW` 里。

## 更新部署

代码更新后重新跑安装脚本即可（幂等）：

```bash
cd /opt/curlviz
sudo git pull
sudo bash deploy/install.sh --domain curlviz.example.com
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

# 删除证书（可选）
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
