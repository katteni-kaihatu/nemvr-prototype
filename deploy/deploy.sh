#!/usr/bin/env bash
# 手元のリポジトリを VPS に反映する (ビルド → 転送 → 再起動)。
# 初回は先に deploy/setup-vps.sh で VPS を構築しておくこと (README / docs/deploy.md 参照)。
#
#   DEPLOY_HOST=root@172.104.89.28 SSH_KEY=~/.ssh/linode.com deploy/deploy.sh
#   PROTO_HOST=example.com PROTO_USER=root SSH_KEY=~/.ssh/<鍵> deploy/deploy.sh
#
# クライアント (Vite) は手元でビルドし、Elixir release は VPS 上でビルドする。
# Nix の Elixir/OTP で作った release は Nix ストアへの動的リンクを含み、
# Ubuntu では動かないため、release は必ず VPS の Elixir/OTP で作る。
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

echo "==> build client"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @proto/client build

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
install -d -o proto -g proto /srv/proto-client
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

echo "==> upload client"
RSYNC=(rsync -az --delete --chown=proto:proto -e "${SSH[*]}")
"${RSYNC[@]}" apps/client/dist/ "$DEPLOY_HOST:/srv/proto-client/"

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
echo "==> done"