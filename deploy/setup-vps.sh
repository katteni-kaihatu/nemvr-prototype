#!/usr/bin/env bash
# 開発用 VPS (Ubuntu / Debian) の初期構築。root で実行する。何度実行しても同じ結果になる (冪等)。
# この VPS は開発・検証環境であり、本番環境ではない (docs/deploy.md 参照)。
#
#   ssh root@<VPS> "PROTO_HOST=<ホスト名> bash -s" < deploy/setup-vps.sh
#
# やること:
#   - Node.js 24 (公式 tarball, SHA256 検証) / pnpm / Caddy / rsync / ufw
#   - Elixir / Erlang (apt) と proto ユーザーの Hex / rebar
#   - Kubo (IPFS) を /usr/local/bin/ipfs に導入し、/var/lib/proto/ipfs を初期化・設定
#   - アプリ用の非 root ユーザー `proto` の作成
#   - systemd: kubo.service (IPFS) / proto-server.service (Elixir release)
#   - Caddy (TLS 終端) と coturn (TURN サーバー)
#   - ファイアウォール (22, 80, 443, 8443, 4001, 3478, TURN の中継ポート範囲のみ許可)
#
# 公開構成:
#   https://$PROTO_HOST/      -> /srv/proto-client (ランディング / ダウンロード)
#   wss://$PROTO_HOST/ws      -> 127.0.0.1:8080 (ワールド同期 / メディア)
#   https://$PROTO_HOST/media/* -> 127.0.0.1:8080 (Kubo ゲートウェイ経由のストリーミング)
#   wss://$PROTO_HOST:8443    -> 127.0.0.1:8081 (Kubo の libp2p WebSocket)
#   turn:$PROTO_HOST:3478     -> coturn (UDP / TCP)。中継は UDP 49160-49200
#
# Kubo の API (5001) とゲートウェイ (8082) は 127.0.0.1 だけで待ち受ける。
set -euo pipefail

# ssh で実行すると cwd が /root のままになる。runuser -u proto は cwd を引き継ぐため、
# proto が読めない /root から Elixir / Kubo を起動して失敗しないように /tmp へ移る。
cd /tmp

: "${PROTO_HOST:?PROTO_HOST (証明書を取るホスト名) を指定してください}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
PNPM_VERSION="${PNPM_VERSION:-12.14.0}"
KUBO_VERSION="${KUBO_VERSION:-}"
IPFS_PATH_DIR="/var/lib/proto/ipfs"

export DEBIAN_FRONTEND=noninteractive

case "$(uname -m)" in
  x86_64)
    NODE_ARCH="x64"
    KUBO_ARCH="amd64"
    ;;
  aarch64 | arm64)
    NODE_ARCH="arm64"
    KUBO_ARCH="arm64"
    ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

# Kubo のバージョンは v 付きで扱う (配布物のパスが v0.x.y のため)。比較用に v を除いた値も持つ。

echo "==> packages"
apt-get update -qq
apt-get install -y -qq \
  caddy coturn rsync ufw xz-utils curl ca-certificates \
  elixir erlang-dev erlang-ssl erlang-inets

# curl が入った後に最新版を解決する (KUBO_VERSION を指定した場合はそれを使う)。
# dist.ipfs.tech に到達できない環境 (一部の VPS / 地域) では GitHub API を使う。
if [ -z "${KUBO_VERSION}" ]; then
  KUBO_VERSION="$(curl -fsSL --connect-timeout 10 https://dist.ipfs.tech/kubo/versions 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)"
fi
if [ -z "${KUBO_VERSION}" ]; then
  KUBO_VERSION="$(curl -fsSL --connect-timeout 10 https://api.github.com/repos/ipfs/kubo/releases/latest 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1 || true)"
fi
: "${KUBO_VERSION:?Kubo のバージョンを解決できませんでした。KUBO_VERSION=v0.40.1 のように指定してください}"
case "$KUBO_VERSION" in
  v*) KUBO_VERSION_NUMBER="${KUBO_VERSION#v}" ;;
  *)
    KUBO_VERSION_NUMBER="$KUBO_VERSION"
    KUBO_VERSION="v${KUBO_VERSION}"
    ;;
esac

echo "==> node ${NODE_VERSION} (${NODE_ARCH})"
if ! /opt/node/bin/node -v 2>/dev/null | grep -qx "v${NODE_VERSION}"; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  file="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
fi
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm

echo "==> pnpm ${PNPM_VERSION}"
if ! /opt/node/bin/pnpm --version 2>/dev/null | grep -qx "${PNPM_VERSION}"; then
  PATH="/opt/node/bin:$PATH" npm install -g --silent "pnpm@${PNPM_VERSION}"
fi
ln -sf /opt/node/bin/pnpm /usr/local/bin/pnpm

echo "==> user and directories"
id proto >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/proto --shell /usr/sbin/nologin proto
mkdir -p /opt/proto/app /srv/proto-client /var/lib/proto/tmp
chown -R proto:proto /opt/proto /srv/proto-client /var/lib/proto
chmod 755 /srv/proto-client

echo "==> elixir toolchain for proto user"
# mix local.hex / local.rebar は初回だけ必要。再実行しても上書きするだけで同じ結果になる。
runuser -u proto -- env HOME=/opt/proto bash -c '
  cd /opt/proto
  mix local.hex --force >/dev/null
  mix local.rebar --force >/dev/null
'

echo "==> kubo ${KUBO_VERSION} (linux-${KUBO_ARCH})"
if ! command -v ipfs >/dev/null 2>&1 || [ "$(ipfs version --number 2>/dev/null || true)" != "${KUBO_VERSION_NUMBER}" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  file="kubo_${KUBO_VERSION}_linux-${KUBO_ARCH}.tar.gz"
  if ! curl -fsSL --retry 2 --connect-timeout 20 -o "$tmp/$file" "https://dist.ipfs.tech/kubo/${KUBO_VERSION}/${file}"; then
    echo "    dist.ipfs.tech に接続できないため GitHub Releases から取得する"
    curl -fsSL --retry 2 --connect-timeout 20 -o "$tmp/$file" \
      "https://github.com/ipfs/kubo/releases/download/${KUBO_VERSION}/${file}"
  fi
  tar -xzf "$tmp/$file" -C "$tmp"
  install -m 0755 "$tmp/kubo/ipfs" /usr/local/bin/ipfs
  rm -rf "$tmp"
fi
/usr/local/bin/ipfs version

echo "==> kubo repository (${IPFS_PATH_DIR})"
install -d -m 750 -o proto -g proto "$IPFS_PATH_DIR"

ipfs_proto() {
  runuser -u proto -- env IPFS_PATH="$IPFS_PATH_DIR" HOME=/opt/proto /usr/local/bin/ipfs "$@"
}

if [ ! -f "$IPFS_PATH_DIR/config" ]; then
  ipfs_proto init --profile=server
fi

# Kubo が libp2p / ゲートウェイ / API を持つ。OTP サーバーは HTTP でだけ話す。
ipfs_proto config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs_proto config Addresses.Gateway /ip4/127.0.0.1/tcp/8082
ipfs_proto config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001","/ip4/0.0.0.0/tcp/8081/ws"]'
ipfs_proto config --json Swarm.RelayService.Enabled true
ipfs_proto config --json Swarm.RelayClient.Enabled true

echo "==> shared secret (TURN)"
# coturn (use-auth-secret) とアプリで同じ秘密を共有する。再実行しても変えない
install -d -m 750 -o root -g proto /etc/proto
if ! grep -q '^TURN_SECRET=' /etc/proto/server.env 2>/dev/null; then
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  (
    umask 077
    cat > /etc/proto/server.env <<ENVFILE
TURN_HOST=${PROTO_HOST}
TURN_PORT=3478
TURN_SECRET=${secret}
ENVFILE
  )
fi
# ホスト名を変えて再実行したときのために、TURN_HOST は毎回合わせる (秘密は変えない)
sed -i "s/^TURN_HOST=.*/TURN_HOST=${PROTO_HOST}/" /etc/proto/server.env
chown root:proto /etc/proto/server.env
chmod 640 /etc/proto/server.env
TURN_SECRET="$(grep '^TURN_SECRET=' /etc/proto/server.env | cut -d= -f2-)"

echo "==> systemd: kubo"
cat > /etc/systemd/system/kubo.service <<EOF
[Unit]
Description=Kubo IPFS daemon (API + Gateway + libp2p)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=proto
Group=proto
Environment=IPFS_PATH=${IPFS_PATH_DIR}
ExecStart=/usr/local/bin/ipfs daemon --migrate=true
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/proto

[Install]
WantedBy=multi-user.target
EOF

echo "==> systemd: proto-server (Elixir release)"
cat > /etc/systemd/system/proto-server.service <<EOF
[Unit]
Description=VR SNS prototype server (Elixir/OTP + Kubo)
After=network-online.target kubo.service
Wants=network-online.target kubo.service

[Service]
User=proto
Group=proto
WorkingDirectory=/opt/proto/app/apps/server
# リバースプロキシ (Caddy) の背後で動かす。公開するのは Caddy だけ。
# Kubo の API / ゲートウェイは localhost。IPFS_PORT は Kubo の libp2p WS の待受ポート。
Environment=PORT=8080 HOST=127.0.0.1 IPFS_PORT=8081 IPFS_PUBLIC_PORT=8443
Environment=IPFS_API_URL=http://127.0.0.1:5001 IPFS_GATEWAY_URL=http://127.0.0.1:8082 CONTENT_MAX_TOTAL_MB=20480
Environment=RELEASE_TMP=/var/lib/proto/tmp
# TURN_HOST / TURN_PORT / TURN_SECRET (coturn と共有。root と proto だけが読める)
EnvironmentFile=-/etc/proto/server.env
ExecStart=/opt/proto/app/apps/server/_build/prod/rel/proto_server/bin/proto_server start
Restart=on-failure
RestartSec=3
MemoryMax=1536M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/proto

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kubo >/dev/null
systemctl restart kubo
systemctl enable proto-server >/dev/null
if [ -x /opt/proto/app/apps/server/_build/prod/rel/proto_server/bin/proto_server ]; then
  systemctl restart proto-server
else
  echo "    proto-server はまだデプロイされていないため起動しない (deploy/deploy.sh の後に起動する)"
fi

echo "==> caddy (${PROTO_HOST})"
cat > /etc/caddy/Caddyfile <<EOF
${PROTO_HOST} {
	encode zstd gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
	}
	handle /ws {
		reverse_proxy 127.0.0.1:8080
	}
	# 動画・ファイルのストリーミング配信 (Range 要求をそのまま流す)
	handle /media/* {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		root * /srv/proto-client
		file_server
	}
}

# Kubo (libp2p) の WebSocket。ブラウザは wss://${PROTO_HOST}:8443/... (/tls/ws) で接続する。
# 8081 は 127.0.0.1 で待ち受け、外には Caddy だけを出す。
${PROTO_HOST}:8443 {
	reverse_proxy 127.0.0.1:8081
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy

echo "==> coturn (TURN)"
cat > /etc/turnserver.conf <<TURNCONF
# VR SNS prototype: WebRTC の中継 (TURN)。認証は共有秘密による時間制限つき認証情報 (TURN REST API)
listening-port=3478
realm=${PROTO_HOST}
use-auth-secret
static-auth-secret=${TURN_SECRET}
fingerprint
no-cli
no-tls
no-dtls
no-software-attribute
# 中継ポートの範囲 (ファイアウォールでも同じ範囲を開ける)
min-port=49160
max-port=49200
# 悪用対策: 1 ユーザーあたりの割り当て数、全体の割り当て数、1 セッションの帯域 (バイト/秒)
user-quota=8
total-quota=300
max-bps=2000000
# 内部ネットワーク宛ての中継は拒否する (VPS の内側への踏み台にされないように)
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=240.0.0.0-255.255.255.255
TURNCONF
chown root:turnserver /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn

echo "==> firewall"
ufw allow 22/tcp >/dev/null    # SSH (先に許可してから有効化する)
ufw allow 80/tcp >/dev/null    # ACME (HTTP-01) と https へのリダイレクト
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw allow 8443/tcp >/dev/null  # Kubo (libp2p wss)。Caddy が 127.0.0.1:8081 へ転送する
ufw allow 4001/tcp >/dev/null  # Kubo の libp2p swarm (TCP)
ufw allow 3478/tcp >/dev/null  # TURN (制御 / TCP 中継)
ufw allow 3478/udp >/dev/null  # TURN (制御 / UDP 中継)
ufw allow 49160:49200/udp >/dev/null  # TURN の中継ポート範囲
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

echo "==> done"
cat <<NEXT
次の手順:
  1. 手元で deploy/deploy.sh を実行する (クライアント + Elixir release を転送)
       DEPLOY_HOST=root@<VPS> SSH_KEY=~/.ssh/<鍵> deploy/deploy.sh
  2. サービスの状態を確認する
       systemctl status kubo proto-server --no-pager
       journalctl -u kubo -u proto-server -n 30 --no-pager
  3. Kubo の peer ID を確認する
       runuser -u proto -- env IPFS_PATH=${IPFS_PATH_DIR} ipfs id
  4. https://${PROTO_HOST}/ を開き、HUD に「IPFS: 接続済み」と出ることを確認する
NEXT
