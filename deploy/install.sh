#!/usr/bin/env bash
# CurlViz 一键部署脚本（Linux ECS）
# 用法：
#   受信证书（需域名）：sudo bash install.sh --domain curlviz.example.com
#   自签证书（无域名）：sudo bash install.sh --self-signed --ip <ECS公网IP>
#   可选：--install-dir /opt/curlviz
#
# 前置条件（脚本会检查）：
#   - root 权限
#   - node ≥ 20、curl、nginx、git、openssl（两种模式都要）
#   - certbot（仅受信证书模式要）
#   - 受信证书模式：域名已解析到本机公网 IP
#   - 自签模式：无需域名/备案/梯子，浏览器首次访问需接受证书警告
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

# ─── 探测公网 IP（自签模式未指定 --ip 时的兜底）─────────────────────────────────
detect_public_ip() {
    local url ip
    for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://ip.sb" "https://myip.ipip.net"; do
        ip=$(curl -fsS --max-time 5 "$url" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)
        if [[ -n "$ip" ]]; then
            echo "$ip"
            return 0
        fi
    done
    return 1
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
DOMAIN=""
IP=""
SELF_SIGNED=false
INSTALL_DIR="/opt/curlviz"

while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)
            DOMAIN="$2"
            shift 2
            ;;
        --ip)
            IP="$2"
            shift 2
            ;;
        --self-signed)
            SELF_SIGNED=true
            shift
            ;;
        --install-dir)
            INSTALL_DIR="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法："
            echo "  受信证书（需域名）：sudo bash install.sh --domain curlviz.example.com"
            echo "  自签证书（无域名）：sudo bash install.sh --self-signed --ip <ECS公网IP>"
            echo "  可选：--install-dir /opt/curlviz"
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

# ─── 确定访问地址（域名或 IP）─────────────────────────────────────────────────
ADDRESS=""
if [[ "$SELF_SIGNED" == true ]]; then
    if [[ -n "$DOMAIN" ]]; then
        ADDRESS="$DOMAIN"
    elif [[ -n "$IP" ]]; then
        ADDRESS="$IP"
    else
        info "未指定 --ip/--domain，尝试自动探测公网 IP..."
        ADDRESS="$(detect_public_ip || true)"
        if [[ -z "$ADDRESS" ]]; then
            error "自动探测公网 IP 失败，请用 --ip <你的ECS公网IP> 显式指定"
            exit 1
        fi
        success "探测到公网 IP：$ADDRESS"
    fi
else
    if [[ -z "$DOMAIN" ]]; then
        read -rp "请输入域名（已解析到本机，如 curlviz.example.com）： " DOMAIN
        if [[ -z "$DOMAIN" ]]; then
            error "域名不能为空（无域名请用 --self-signed --ip <ECS公网IP>）"
            exit 1
        fi
    fi
    ADDRESS="$DOMAIN"
fi

info "检查前置依赖..."
# openssl 两种模式都要（生成 token / 自签证书）；certbot 仅受信证书模式要。
DEPS=(node curl nginx git openssl)
if [[ "$SELF_SIGNED" != true ]]; then
    DEPS+=(certbot)
fi
for cmd in "${DEPS[@]}"; do
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
CURLVIZ_ALLOWED_ORIGINS=https://$ADDRESS
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

# ─── 配置 nginx + TLS ─────────────────────────────────────────────────────────
# 写到 conf.d（Debian 与 CentOS 的 nginx.conf 默认都 include 这个目录）。
NGINX_SITE="/etc/nginx/conf.d/curlviz.conf"

if [[ "$SELF_SIGNED" == true ]]; then
    # 自签证书：openssl 生成 → nginx 直接配 HTTPS（不碰 certbot / 域名 / 备案）
    info "生成自签证书..."
    TLS_DIR="/etc/curlviz/tls"
    mkdir -p "$TLS_DIR"
    # SAN：IP 地址用 IP:，域名用 DNS:（现代浏览器只认 SAN，不认 CN）
    if [[ "$ADDRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$ADDRESS" == *:* ]]; then
        SAN="IP:$ADDRESS"
    else
        SAN="DNS:$ADDRESS"
    fi
    if [[ ! -f "$TLS_DIR/cert.pem" || ! -f "$TLS_DIR/key.pem" ]]; then
        openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
            -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
            -subj "/CN=CurlViz Self-Signed" \
            -addext "subjectAltName=$SAN"
        chmod 600 "$TLS_DIR/key.pem"
        success "已生成自签证书（SAN=$SAN，有效期 3650 天）"
    else
        warn "自签证书已存在，跳过生成（换 IP/域名需 rm $TLS_DIR/*.pem 后重跑）"
    fi

    info "配置 nginx（自签 HTTPS）..."
    # 证书已先于本配置生成，故 nginx -t 时 ssl_certificate 文件已存在，必过。
    if [[ ! -f "$NGINX_SITE" ]]; then
        sed -e "s|__ADDRESS__|$ADDRESS|g" \
            -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
            "$INSTALL_DIR/deploy/nginx-selfsigned.conf" > "$NGINX_SITE"
        success "已写入 $NGINX_SITE（自签 HTTPS）"
    else
        warn "$NGINX_SITE 已存在，跳过写入（如需重新生成：rm 后重跑）"
    fi
    if ! nginx -t; then
        error "nginx 配置测试失败"
        exit 1
    fi
    systemctl reload nginx
    success "nginx 已加载（自签 HTTPS）"
else
    # 受信证书：纯 HTTP 模板 → certbot --nginx 自动签 + 加 TLS + 跳转
    info "配置 nginx 反代（HTTP 模板）..."
    mkdir -p /var/www/certbot
    if [[ ! -f "$NGINX_SITE" ]]; then
        sed -e "s|__DOMAIN__|$DOMAIN|g" \
            -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
            "$INSTALL_DIR/deploy/nginx.conf" > "$NGINX_SITE"
        success "已写入 $NGINX_SITE（HTTP 模板）"
    else
        warn "$NGINX_SITE 已存在，跳过写入（保留现有/TLS 配置）"
        warn "如需重新生成：rm $NGINX_SITE 后重跑本脚本"
    fi
    # 此时无证书引用，纯 HTTP，nginx -t 必过；TLS 由下面的 certbot 加。
    if ! nginx -t; then
        error "nginx 配置测试失败"
        exit 1
    fi
    systemctl reload nginx
    success "nginx 已加载（HTTP）"

    info "certbot 签证书（需要域名已解析到本机、80 端口放行）..."
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
        success "TLS 证书已签发，nginx 已自动加 HTTPS + 跳转，certbot 定时续签"
    else
        warn "certbot 失败（域名未解析到本机？80 端口未放行？）"
        warn "nginx 仍可用 HTTP 访问；修好后手动跑：certbot --nginx -d $DOMAIN --redirect"
    fi
fi

# ─── 完成 ─────────────────────────────────────────────────────────────────────
echo
success "═══════════════════════════════════════════════════════════"
success "  CurlViz 部署完成"
success "═══════════════════════════════════════════════════════════"
echo
info "前端 baseUrl：https://$ADDRESS"
info "前端 token：  $TOKEN"
echo
info "配置文件：$ENV_FILE"
info "服务日志：journalctl -u curlviz-agent -f"
info "nginx 日志：/var/log/nginx/error.log"
echo
if [[ "$SELF_SIGNED" == true ]]; then
    warn "自签证书：浏览器首次访问 https://$ADDRESS 会弹「不安全/证书无效」警告，"
    warn "点「高级 → 继续访问（不安全）」即可（团队每人点一次）；token 仍走 TLS 加密。"
    echo
fi
warn "下一步："
warn "  1. 打开浏览器访问 https://$ADDRESS"
warn "  2. 在「执行机管理」里填 baseUrl=https://$ADDRESS 和上面的 token"
warn "  3. 按需修改 $ENV_FILE 的 CURLVIZ_ALLOW（SSRF 白名单）"
warn "  4. 修改后 systemctl restart curlviz-agent"
echo
