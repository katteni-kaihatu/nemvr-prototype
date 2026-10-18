#!/usr/bin/env bash
# VPS (Ubuntu) の初期構築。root で実行する。何度実行しても同じ結果になる (冪等)。
#
#   ssh root@<VPS> "PROTO_HOST=<ホスト名> bash -s" < deploy/setup-vps.sh
#
# やること:
#   - Node.js (公式 tarball, SHA256 検証) / pnpm / Caddy / rsync / ufw の導入
#   - アプリ用の非 root ユーザー `proto` の作成
#   - Caddy (TLS 終端) と systemd サービスの設定
#   - ファイアウォール (22, 80, 443, 8443 のみ許可)
#
# 公開構成:
#   https://$PROTO_HOST/      -> /srv/proto-client (静的ファイル)
#   wss://$PROTO_HOST/ws      -> 127.0.0.1:8080 (ワールド同期)
#   wss://$PROTO_HOST:8443    -> 127.0.0.1:8081 (IPFS / libp2p の WebSocket)
set -euo pipefail

: "${PROTO_HOST:?PROTO_HOST (証明書を取るホスト名) を指定してください}"
NODE_VERSION="${NODE_VERSION:-24.15.0}"
PNPM_VERSION="${PNPM_VERSION:-12.14.0}"

export DEBIAN_FRONTEND=noninteractive

echo "==> packages"
apt-get update -qq
apt-get install -y -qq caddy rsync ufw xz-utils curl ca-certificates

echo "==> node ${NODE_VERSION}"
if ! /opt/node/bin/node -v 2>/dev/null | grep -qx "v${NODE_VERSION}"; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  base="https://nodejs.org/dist/v${NODE_VERSION}"
  file="node-v${NODE_VERSION}-linux-x64.tar.xz"
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
mkdir -p /opt/proto/app /srv/proto-client
chown -R proto:proto /opt/proto /srv/proto-client
chmod 755 /srv/proto-client

echo "==> systemd service"
cat > /etc/systemd/system/proto-server.service <<EOF
[Unit]
Description=VR SNS prototype server (world sync + IPFS node)
After=network-online.target
Wants=network-online.target

[Service]
User=proto
Group=proto
WorkingDirectory=/opt/proto/app/apps/server
# リバースプロキシ (Caddy) の背後で動かす。公開するのは Caddy だけ
Environment=NODE_ENV=production HOME=/opt/proto HOST=127.0.0.1 PORT=8080 IPFS_PORT=8081 IPFS_PUBLIC_PORT=8443
ExecStart=/opt/proto/app/apps/server/node_modules/.bin/tsx src/index.ts
Restart=on-failure
RestartSec=3
MemoryMax=1G
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable proto-server >/dev/null

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
	handle {
		root * /srv/proto-client
		try_files {path} /index.html
		file_server
	}
}

# IPFS (libp2p) の WebSocket。ブラウザは wss://${PROTO_HOST}:8443 (/tls/ws) で接続する
${PROTO_HOST}:8443 {
	reverse_proxy 127.0.0.1:8081
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy

echo "==> firewall"
ufw allow 22/tcp >/dev/null    # SSH (先に許可してから有効化する)
ufw allow 80/tcp >/dev/null    # ACME (HTTP-01) と https へのリダイレクト
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw allow 8443/tcp >/dev/null  # IPFS (libp2p wss)
ufw --force enable >/dev/null
ufw status | sed 's/^/    /'

echo "==> done"
