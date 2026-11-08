#!/usr/bin/env bash
# CurlViz 一键部署脚本（Linux ECS）
# 用法：
#   受信证书（需域名）：sudo bash install.sh --domain curlviz.example.com
#   自签证书（无域名）：sudo bash install.sh --self-signed --ip <ECS公网IP>
#   可选：--install-dir /opt/curlviz
#         --http-port 8080 --https-port 8443（仅自签模式可换端口；受信模式固定 80/443）
#
# 前置条件（脚本会检查）：
#   - root 权限
#   - node ≥ 20（过旧/缺失时脚本可代装 npmmirror 的 v22 LTS 二进制到 /usr/local）
#   - curl、nginx、git、openssl（两种模式都要）
#   - certbot（仅受信证书模式要）
#   - 受信证书模式：域名已解析到本机公网 IP
#   - 自签模式：无需域名/备案/梯子，浏览器首次访问需接受证书警告
#
# 与已有 nginx 共存：配置增量写入 /etc/nginx/conf.d/curlviz.conf（唯一文件名，
# 不碰现有站点），按 server_name/SNI 路由互不干扰，reload 平滑生效（零停机）。
# 端口预检：80/443（或自定义端口）若被非 nginx 进程占用，会报占用者并给出出路。
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

# ─── 端口预检（兼容已有 nginx / 端口被占场景）──────────────────────────────────
# 返回占用指定 TCP 端口的进程名：空闲返回空串；本机 nginx 返回 "nginx"。
# ss（iproute2）与 netstat（net-tools）任一可用即可；都没有则跳过（nginx 会兜底报错）。
port_owner() {
    local port="$1" line=""
    # 扫描整行找以 ":端口" 结尾的字段（Local Address 列）——不钉死列号，
    # 兼容 ss 带/不带 Netid 列的两种输出格式，也兼容 netstat。
    if command -v ss &>/dev/null; then
        line=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '{for(i=1;i<=NF;i++) if($i ~ p"$"){print; exit}}')
    elif command -v netstat &>/dev/null; then
        line=$(netstat -ltnp 2>/dev/null | awk -v p=":$port" '{for(i=1;i<=NF;i++) if($i ~ p"$"){print; exit}}')
    else
        echo ""
        return 0
    fi
    if [[ -z "$line" ]]; then
        echo ""
        return 0
    fi
    if [[ "$line" == *nginx* ]]; then
        echo "nginx"
        return 0
    fi
    local who=""
    # ss 进程列：users:(("docker-proxy",pid=1234,fd=4))
    who=$(printf '%s' "$line" | grep -oE '"[^"]+",pid=' | head -1 | cut -d'"' -f2 || true)
    # netstat 进程列：1234/apache2
    if [[ -z "$who" ]]; then
        who=$(printf '%s' "$line" | awk '{print $NF}' | cut -d/ -f2-)
    fi
    echo "${who:-unknown}"
}

# 检查一个端口能否被本机 nginx 使用：空闲→可绑；nginx 持有→共存；其他→报错退出。
check_port() {
    local port="$1" owner
    owner="$(port_owner "$port")"
    if [[ -z "$owner" ]]; then
        success "端口 $port 空闲（nginx 将绑定它）"
    elif [[ "$owner" == "nginx" ]]; then
        success "端口 $port 由本机 nginx 持有（新增 server 块按 server_name 共存，reload 平滑、不影响现有站点）"
    else
        error "端口 $port 被非 nginx 进程占用：$owner"
        error "  方案 A：停掉占用者后重跑（systemctl stop <服务> / docker stop <容器>）"
        if [[ "$SELF_SIGNED" == true ]]; then
            error "  方案 B：换端口重跑，如 --http-port 8080 --https-port 8443（访问 https://$ADDRESS:8443，安全组放行 8443）"
        else
            error "  受信证书模式固定用 80/443（certbot HTTP-01 验证走标准端口）；请停掉占用者，或改用 --self-signed 后换端口"
        fi
        exit 1
    fi
}

# ─── node ≥ 20 检查与代装（发行版自带普遍太老，apt 装不到 20+）────────────────
# 过旧/缺失时给出走 npmmirror 国内镜像的精确命令，并可由脚本直接代装 LTS 二进制到
# /usr/local（/usr/local/bin 在 PATH 里优先于 /usr/bin，天然覆盖发行版旧 node；
# systemd 服务默认 PATH 同样优先 /usr/local/bin）。
ensure_node() {
    local ver="" major="" arch ans
    if command -v node &>/dev/null; then
        ver=$(node -v 2>/dev/null || true)
        major=$(printf '%s' "$ver" | sed 's/v//' | cut -d. -f1)
        if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 20 ]]; then
            success "node ${ver}（≥ 20）"
            return 0
        fi
        warn "node 版本过低：${ver:-无法解析}（需要 ≥ 20；发行版 apt 源的 node 普遍太老，推荐直接装 LTS 二进制）"
    else
        warn "未检测到 node（发行版 apt 源的 node 普遍 < 20，推荐直接装 LTS 二进制）"
    fi
    case "$(uname -m)" in
        x86_64)        arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *)             arch="" ;;
    esac
    if [[ -z "$arch" ]]; then
        error "无法识别架构 $(uname -m)，请自行安装 node ≥ 20 后重跑"
        exit 1
    fi
    local url="https://registry.npmmirror.com/-/binary/node/${NODE_LTS}/node-${NODE_LTS}-linux-${arch}.tar.gz"
    if ! command -v curl &>/dev/null; then
        error "代装需要 curl；请先装 curl，或手动执行："
        error "  curl -fSL $url -o /tmp/node.tar.gz"
        error "  sudo tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1"
        exit 1
    fi
    # 非交互（如 curl | bash）时 read 失败按 N 处理，绝不默认改系统
    ans=""
    read -rp "是否代装 node ${NODE_LTS}（linux-${arch}，npmmirror 国内镜像 ~54MB）到 /usr/local？[y/N] " ans || true
    if [[ "$ans" != y && "$ans" != Y ]]; then
        info "手动安装（两条命令，走国内镜像无需梯子）："
        echo "  curl -fSL $url -o /tmp/node.tar.gz"
        echo "  sudo tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1"
        echo "  node -v && npm -v   # 应显示 v22.x"
        exit 1
    fi
    info "下载 node ${NODE_LTS}（linux-${arch}）..."
    if ! curl -fSL --max-time 300 "$url" -o /tmp/curlviz-node.tar.gz; then
        error "下载失败（网络？镜像挂了？），可稍后重试或手动执行上面提示的命令"
        exit 1
    fi
    info "解压到 /usr/local..."
    if ! tar -xzf /tmp/curlviz-node.tar.gz -C /usr/local --strip-components=1; then
        error "解压失败（磁盘空间？权限需 root？）"
        exit 1
    fi
    rm -f /tmp/curlviz-node.tar.gz
    hash -r 2>/dev/null || true
    ver=$(node -v 2>/dev/null || true)
    major=$(printf '%s' "$ver" | sed 's/v//' | cut -d. -f1)
    if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 20 ]]; then
        success "node ${ver} 已就绪（/usr/local/bin/node，PATH 优先于发行版旧 node）"
    else
        error "代装后 node 仍不可用（PATH 缓存？重开 shell 或检查 /usr/local/bin/node）"
        exit 1
    fi
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
DOMAIN=""
IP=""
SELF_SIGNED=false
INSTALL_DIR="/opt/curlviz"
HTTP_PORT=80
HTTPS_PORT=443
NODE_LTS=v22.20.0   # 代装 node 用的 LTS 版本（npmmirror 镜像；脚本底线仍是 ≥ 20，升级时改这里）

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
        --http-port)
            HTTP_PORT="$2"
            shift 2
            ;;
        --https-port)
            HTTPS_PORT="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法："
            echo "  受信证书（需域名）：sudo bash install.sh --domain curlviz.example.com"
            echo "  自签证书（无域名）：sudo bash install.sh --self-signed --ip <ECS公网IP>"
            echo "  可选：--install-dir /opt/curlviz"
            echo "        --http-port 8080 --https-port 8443（仅自签模式；受信模式固定 80/443）"
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

# ─── 端口合法性 ───────────────────────────────────────────────────────────────
for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    if ! [[ "$p" =~ ^[0-9]+$ ]] || [[ "$p" -lt 1 || "$p" -gt 65535 ]]; then
        error "端口非法：$p（需 1–65535 的整数）"
        exit 1
    fi
done
if [[ "$HTTP_PORT" == "$HTTPS_PORT" ]]; then
    error "--http-port 与 --https-port 不能相同（HTTP 会跳转到 HTTPS，同端口会死循环）"
    exit 1
fi
if [[ "$SELF_SIGNED" != true && ( "$HTTP_PORT" != "80" || "$HTTPS_PORT" != "443" ) ]]; then
    error "受信证书模式固定用 80/443（certbot HTTP-01 验证走标准端口）；要换端口请用 --self-signed"
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

# 对外 origin（端口感知）：443 省略端口，非标端口带上（.env / 打印 / 跳转都用它）
if [[ "$HTTPS_PORT" == "443" ]]; then
    ORIGIN="https://$ADDRESS"
else
    ORIGIN="https://$ADDRESS:$HTTPS_PORT"
fi

info "检查前置依赖..."
# openssl 两种模式都要（生成 token / 自签证书）；certbot 仅受信证书模式要。
# node 单独走 ensure_node（apt 源的 node 普遍太老，缺失/过旧时代装 LTS 二进制）
DEPS=(curl nginx git openssl)
if [[ "$SELF_SIGNED" != true ]]; then
    DEPS+=(certbot)
fi
for cmd in "${DEPS[@]}"; do
    if ! command -v "$cmd" &>/dev/null; then
        error "未找到 $cmd，请先安装（Debian/Ubuntu：apt-get install -y $cmd；CentOS：yum install -y $cmd）"
        exit 1
    fi
done
success "依赖检查通过（${DEPS[*]}）"

ensure_node

# ─── 端口预检（在复制代码/构建之前，冲突早发现早退出）─────────────────────────
info "预检端口占用..."
if [[ "$SELF_SIGNED" == true ]]; then
    check_port "$HTTP_PORT"
    check_port "$HTTPS_PORT"
else
    check_port 80
    check_port 443
fi

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

# ─── SELinux（CentOS/RHEL enforcing 时）────────────────────────────────────────
# nginx 读 /opt 下的静态文件需要 httpd_sys_content_t 上下文，否则 403。
# chcon 只标记我们自己的产物，安全；反代 connect 权限（httpd_can_network_connect）
# 是系统级安全策略，不自动改，仅在需要时提示手动命令。
if command -v getenforce &>/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    if command -v chcon &>/dev/null; then
        if chcon -R -t httpd_sys_content_t "$INSTALL_DIR/web/dist" 2>/dev/null; then
            success "SELinux：已给 web/dist 打 httpd_sys_content_t 上下文"
        else
            warn "SELinux chcon 失败；若 nginx 读静态文件 403，手动：chcon -R -t httpd_sys_content_t $INSTALL_DIR/web/dist"
        fi
    fi
    warn "SELinux enforcing：若 /exec 反代 502，需放行 nginx 网络连接：setsebool -P httpd_can_network_connect 1"
fi

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
CURLVIZ_ALLOWED_ORIGINS=$ORIGIN
EOF
    chmod 600 "$ENV_FILE"
    success "已生成 token（$TOKEN）和白名单（内网段），请按需修改 $ENV_FILE"
else
    warn "$ENV_FILE 已存在，跳过生成（保留你的配置）"
    TOKEN=$(grep '^CURLVIZ_TOKEN=' "$ENV_FILE" | cut -d= -f2)
    warn "换端口重跑时记得同步改 $ENV_FILE 的 CURLVIZ_ALLOWED_ORIGINS=$ORIGIN"
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
# 增量写入、唯一文件名，不碰现有站点；reload 平滑生效。
NGINX_SITE="/etc/nginx/conf.d/curlviz.conf"

# nginx 加载配置：已运行→reload（平滑、现有站点零停机）；未运行→启动。enable 保证开机自启。
load_nginx() {
    systemctl enable nginx
    if ! systemctl reload-or-restart nginx; then
        error "nginx 加载失败（端口冲突？查看：journalctl -u nginx -n 30 / /var/log/nginx/error.log）"
        exit 1
    fi
}

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

    info "配置 nginx（自签 HTTPS，HTTP=$HTTP_PORT → HTTPS=$HTTPS_PORT）..."
    # 证书已先于本配置生成，故 nginx -t 时 ssl_certificate 文件已存在，必过。
    # 跳转目标端口感知：443 省略端口，非标端口显式带上。
    if [[ "$HTTPS_PORT" == "443" ]]; then
        REDIRECT_BASE='https://$host'
    else
        REDIRECT_BASE="https://\$host:$HTTPS_PORT"
    fi
    if [[ ! -f "$NGINX_SITE" ]]; then
        sed -e "s|__ADDRESS__|$ADDRESS|g" \
            -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
            -e "s|__HTTP_PORT__|$HTTP_PORT|g" \
            -e "s|__HTTPS_PORT__|$HTTPS_PORT|g" \
            -e "s|__REDIRECT_BASE__|$REDIRECT_BASE|g" \
            "$INSTALL_DIR/deploy/nginx-selfsigned.conf" > "$NGINX_SITE"
        success "已写入 $NGINX_SITE（自签 HTTPS）"
    else
        warn "$NGINX_SITE 已存在，跳过写入（换端口重跑需先 rm $NGINX_SITE 再重跑）"
    fi
    if ! nginx -t; then
        error "nginx 配置测试失败（详见上方 nginx 输出；常见：现有配置语法错 / 缺 http_ssl_module / server_name 冲突）"
        exit 1
    fi
    load_nginx
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
        error "nginx 配置测试失败（详见上方 nginx 输出）"
        exit 1
    fi
    load_nginx
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
info "前端 baseUrl：$ORIGIN"
info "前端 token：  $TOKEN"
echo
info "配置文件：$ENV_FILE"
info "服务日志：journalctl -u curlviz-agent -f"
info "nginx 日志：/var/log/nginx/error.log"
echo
if [[ "$SELF_SIGNED" == true ]]; then
    warn "自签证书：浏览器首次访问 $ORIGIN 会弹「不安全/证书无效」警告，"
    warn "点「高级 → 继续访问（不安全）」即可（团队每人点一次）；token 仍走 TLS 加密。"
    echo
fi
warn "下一步："
warn "  1. 安全组/防火墙放行 $HTTPS_PORT（受信模式另需 80）"
warn "  2. 打开浏览器访问 $ORIGIN"
warn "  3. 在「执行机管理」里填 baseUrl=$ORIGIN 和上面的 token"
warn "  4. 按需修改 $ENV_FILE 的 CURLVIZ_ALLOW（SSRF 白名单）"
warn "  5. 修改后 systemctl restart curlviz-agent"
echo