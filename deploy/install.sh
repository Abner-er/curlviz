#!/usr/bin/env bash
# CurlViz 一键部署脚本（Linux ECS）
# 用法：sudo bash install.sh [--domain curlviz.example.com] [--install-dir /opt/curlviz]
#
# 前置条件（脚本会检查）：
#   - root 权限
#   - node ≥ 20、curl、nginx、certbot、git
#   - 域名已解析到本机公网 IP（certbot 签证书用）
#
# 幂等：可重复跑，已存在的配置不覆盖。

set -euo pipefail

# ─── 颜色输出 ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
DOMAIN=""
INSTALL_DIR="/opt/curlviz"

while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --install-dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法：sudo bash install.sh [--domain curlviz.example.com] [--install-dir /opt/curlviz]"
            exit 0
            ;;
        *)
            error "未知参数：$1"
            exit 1
            ;;
    esac
done

# ─── 前置检查 ─────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    error "必须以 root 运行：sudo bash install.sh"
    exit 1
fi

if [[ -z "$DOMAIN" ]]; then
    read -rp "请输入域名（已解析到本机，如 curlviz.example.com）： " DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        error "域名不能为空"
        exit 1
    fi
fi

info "检查前置依赖..."
for cmd in node curl nginx certbot git; do
    if ! command -v "$cmd" &>/dev/null; then
        error "未找到 $cmd，请先安装"
        exit 1
    fi
done

# 检查 node 版本 ≥ 20
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VERSION -lt 20 ]]; then
    error "node 版本过低（当前 v${NODE_VERSION}，需要 ≥ 20）"
    exit 1
fi
success "依赖检查通过（node v${NODE_VERSION}）"

# ─── 克隆或更新代码 ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SOURCE="$(dirname "$SCRIPT_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "更新已有安装（$INSTALL_DIR）..."
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "git pull 失败，使用本地代码继续"
else
    info "从本地复制到 $INSTALL_DIR..."
    mkdir -p "$(dirname "$INSTALL_DIR")"
    cp -r "$REPO_SOURCE" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# ─── 安装依赖 ─────────────────────────────────────────────────────────────────
info "npm ci（安装依赖）..."
npm ci --production=false

# ─── 构建前端 ─────────────────────────────────────────────────────────────────
info "vite build（构建前端）..."
npm run build

# ─── 配置 .env ────────────────────────────────────────────────────────────────
ENV_DIR="/etc/curlviz"
ENV_FILE="$ENV_DIR/.env"
mkdir -p "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
    info "生成 $ENV_FILE..."
    TOKEN=$(openssl rand -hex 32)
    cat > "$ENV_FILE" <<EOF
# CurlViz Agent 配置（$(date -Iseconds) 由 install.sh 生成）
# 修改后需 systemctl restart curlviz-agent

CURLVIZ_TOKEN=$TOKEN
CURLVIZ_ALLOW=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
CURLVIZ_PORT=8788
CURLVIZ_ALLOWED_ORIGINS=https://$DOMAIN
EOF
    chmod 600 "$ENV_FILE"
    success "已生成 token（$TOKEN）和白名单（内网段），请按需修改 $ENV_FILE"
else
    warn "$ENV_FILE 已存在，跳过生成（保留你的配置）"
    TOKEN=$(grep '^CURLVIZ_TOKEN=' "$ENV_FILE" | cut -d= -f2)
fi

# ─── 安装 systemd 单元 ────────────────────────────────────────────────────────
info "安装 systemd 服务..."
SERVICE_FILE="/etc/systemd/system/curlviz-agent.service"
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$INSTALL_DIR/deploy/curlviz-agent.service" > "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable curlviz-agent
systemctl restart curlviz-agent
sleep 2
if systemctl is-active --quiet curlviz-agent; then
    success "curlviz-agent 服务已启动"
else
    error "服务启动失败，查看日志：journalctl -u curlviz-agent -n 50"
    exit 1
fi

# ─── 配置 nginx ───────────────────────────────────────────────────────────────
# 写到 conf.d（Debian 与 CentOS 的 nginx.conf 默认都 include 这个目录），
# 不用 sites-available/sites-enabled（CentOS 没有）。
info "配置 nginx 反代..."
NGINX_SITE="/etc/nginx/conf.d/curlviz.conf"
mkdir -p /var/www/certbot

# 仅当配置不存在时写模板：重跑时保留 certbot 已注入的 TLS 配置（幂等）。
# 模板是纯 HTTP，nginx -t 不会因证书尚不存在而失败；TLS 由下面的 certbot 加。
if [[ ! -f "$NGINX_SITE" ]]; then
    sed -e "s|__DOMAIN__|$DOMAIN|g" \
        -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
        "$INSTALL_DIR/deploy/nginx.conf" > "$NGINX_SITE"
    success "已写入 $NGINX_SITE（HTTP 模板）"
else
    warn "$NGINX_SITE 已存在，跳过写入（保留现有/TLS 配置）"
    warn "如需重新生成：rm $NGINX_SITE 后重跑本脚本"
fi

# 测试配置（此时无证书引用，纯 HTTP，必过）
if ! nginx -t; then
    error "nginx 配置测试失败"
    exit 1
fi
systemctl reload nginx
success "nginx 已加载（HTTP）"

# ─── 签 TLS 证书 ──────────────────────────────────────────────────────────────
# certbot --nginx 会：经 HTTP-01 验证签证书 → 自动改写上面的 conf 加 listen 443 ssl
# + ssl_certificate + 80→443 跳转（--redirect）→ reload nginx。
info "certbot 签证书（需要域名已解析到本机、80 端口放行）..."
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
    success "TLS 证书已签发，nginx 已自动加 HTTPS + 跳转，certbot 定时续签"
else
    warn "certbot 失败（域名未解析到本机？80 端口未放行？）"
    warn "nginx 仍可用 HTTP 访问；修好后手动跑：certbot --nginx -d $DOMAIN --redirect"
fi

# ─── 完成 ─────────────────────────────────────────────────────────────────────
echo
success "═══════════════════════════════════════════════════════════"
success "  CurlViz 部署完成"
success "═══════════════════════════════════════════════════════════"
echo
info "前端 baseUrl：https://$DOMAIN"
info "前端 token：  $TOKEN"
echo
info "配置文件：$ENV_FILE"
info "服务日志：journalctl -u curlviz-agent -f"
info "nginx 日志：/var/log/nginx/error.log"
echo
warn "下一步："
warn "  1. 打开浏览器访问 https://$DOMAIN"
warn "  2. 在「执行机管理」里填 baseUrl=https://$DOMAIN 和上面的 token"
warn "  3. 按需修改 $ENV_FILE 的 CURLVIZ_ALLOW（SSRF 白名单）"
warn "  4. 修改后 systemctl restart curlviz-agent"
echo
