#!/usr/bin/env bash
# 手元のリポジトリを開発用 VPS に反映する (ビルド → 転送 → 再起動)。
# この VPS は開発・検証環境であり、本番環境ではない (docs/deploy.md 参照)。
# 初回は先に deploy/setup-vps.sh で VPS を構築しておくこと (README / docs/deploy.md 参照)。
#
#   DEPLOY_HOST=root@172.104.89.28 SSH_KEY=~/.ssh/linode.com deploy/deploy.sh
#   PROTO_HOST=example.com PROTO_USER=root SSH_KEY=~/.ssh/<鍵> deploy/deploy.sh
#
# サーバー (Elixir) は VPS 上で release を作る。起動中の Kubo は再起動しない。
# ネイティブクライアントの配布物 (dist/) があれば、ダウンロード用に一緒に転送する。
set -euo pipefail

if [ -z "${DEPLOY_HOST:-}" ]; then
  : "${PROTO_HOST:?DEPLOY_HOST (例: root@203.0.113.10) か PROTO_HOST を指定してください}"
  PROTO_USER="${PROTO_USER:-root}"
  DEPLOY_HOST="${PROTO_USER}@${PROTO_HOST}"
fi

SSH_KEY="${SSH_KEY:-}"
SSH=(ssh -o BatchMode=yes)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

cd "$(dirname "$0")/.."

echo "==> upload server source for the remote release build"
"${SSH[@]}" "$DEPLOY_HOST" "install -d -o proto -g proto /opt/proto/build/apps/server"
RSYNC_SRC=(rsync -az --delete --chown=proto:proto
  --exclude _build --exclude deps --exclude test --exclude .elixir_ls
  -e "${SSH[*]}")
"${RSYNC_SRC[@]}" apps/server/ "$DEPLOY_HOST:/opt/proto/build/apps/server/"

echo "==> build server (Elixir release on the VPS)"
"${SSH[@]}" "$DEPLOY_HOST" 'runuser -u proto -- env HOME=/opt/proto MIX_ENV=prod bash -c "cd /opt/proto/build/apps/server && mix deps.get --only prod && mix release --overwrite"'

echo "==> prepare remote directories and keep previous versions"
"${SSH[@]}" "$DEPLOY_HOST" 'set -euo pipefail
install -d -o proto -g proto /srv/proto-client /srv/proto-client/downloads
install -d -o proto -g proto /opt/proto/app/apps/server/_build/prod/rel
REL=/opt/proto/app/apps/server/_build/prod/rel/proto_server
if [ -d "$REL" ]; then
  rm -rf "${REL}.prev"
  cp -a "$REL" "${REL}.prev"
fi
if [ -d /srv/proto-client ] && [ -n "$(ls -A /srv/proto-client 2>/dev/null || true)" ]; then
  rm -rf /srv/proto-client.prev
  cp -a /srv/proto-client /srv/proto-client.prev
fi'

echo "==> build and upload Pion voice relay"
bash scripts/build-voice.sh
VOICE_HOST="${DEPLOY_HOST#*@}"
PUBLIC_IP="${PROTO_PUBLIC_IP:-$(getent ahostsv4 "$VOICE_HOST" | awk 'NR==1{print $1}')}"
if [ -z "$PUBLIC_IP" ]; then
  echo "PROTO_PUBLIC_IP is required for the voice relay" >&2
  exit 1
fi
"${SSH[@]}" "$DEPLOY_HOST" "install -d -o proto -g proto /opt/proto/voice"
rsync -az --chown=proto:proto -e "${SSH[*]}" apps/voice/voice "$DEPLOY_HOST:/opt/proto/voice/voice"
sed "s/__PUBLIC_IP__/${PUBLIC_IP}/" deploy/voice.service > /tmp/proto-voice.service
rsync -az --chown=root:root -e "${SSH[*]}" /tmp/proto-voice.service "$DEPLOY_HOST:/etc/systemd/system/proto-voice.service"
"${SSH[@]}" "$DEPLOY_HOST" "systemctl daemon-reload && systemctl enable proto-voice >/dev/null && systemctl restart proto-voice && systemctl is-active proto-voice"

echo "==> upload landing page"
RSYNC=(rsync -az --delete --exclude downloads --chown=proto:proto -e "${SSH[*]}")
"${RSYNC[@]}" deploy/landing/ "$DEPLOY_HOST:/srv/proto-client/"

echo "==> upload client packages (if built)"
for artifact in \
  dist/ProtoSNS-godot-x86_64.AppImage \
  dist/ProtoSNS-godot-x86_64.AppImage.sha256 \
  dist/ProtoSNS-godot-linux-x86_64.tar.gz \
  dist/ProtoSNS-godot-linux-x86_64.tar.gz.sha256 \
  dist/ProtoSNS-godot-windows-x86_64.zip \
  dist/ProtoSNS-godot-windows-x86_64.zip.sha256 \
  dist/ProtoSNS-windows-x86_64.zip \
  dist/ProtoSNS-windows-x86_64.zip.sha256 \
  dist/ProtoSNS-x86_64.AppImage \
  dist/ProtoSNS-x86_64.AppImage.sha256; do
  if [ -f "$artifact" ]; then
    rsync -az --chown=proto:proto -e "${SSH[*]}" "$artifact" "$DEPLOY_HOST:/srv/proto-client/downloads/"
  else
    echo "  skip: $artifact (not built)"
  fi
done

echo "==> install release"
"${SSH[@]}" "$DEPLOY_HOST" 'set -euo pipefail
rsync -a --delete /opt/proto/build/apps/server/_build/prod/rel/proto_server/ /opt/proto/app/apps/server/_build/prod/rel/proto_server/
chown -R proto:proto /opt/proto/app/apps/server/_build/prod/rel/proto_server'

echo "==> restart proto-server (Kubo は再起動しない)"
"${SSH[@]}" "$DEPLOY_HOST" 'set -euo pipefail
systemctl is-active --quiet kubo || echo "WARNING: kubo.service is not active (IPFS の取得・pin は失敗する)"
systemctl restart proto-server
sleep 4
systemctl is-active proto-server
journalctl -u proto-server -n 12 --no-pager -o cat'
echo "==> ensure Caddy voice route and firewall"
"${SSH[@]}" "$DEPLOY_HOST" "bash -s" <<'REMOTE'
set -euo pipefail
if ! grep -q 'handle /voice/' /etc/caddy/Caddyfile; then
  awk '/^[[:space:]]*handle \{/ && !done {
    print "\thandle /voice/* {"
    print "\t\treverse_proxy 127.0.0.1:8092"
    print "\t}"
    done = 1
  }
  { print }' /etc/caddy/Caddyfile > /tmp/Caddyfile.voice
  mv /tmp/Caddyfile.voice /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
ufw allow 3480/udp >/dev/null
REMOTE

echo "==> done"
echo "    site:      https://${DEPLOY_HOST#*@}/"
echo "    websocket: wss://${DEPLOY_HOST#*@}/ws"
echo "    voice:     https://${DEPLOY_HOST#*@}/voice/offer"
