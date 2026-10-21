#!/usr/bin/env bash
# 手元のリポジトリを VPS に反映する (ビルド → 転送 → 再起動)。
# 初回は先に deploy/setup-vps.sh で VPS を構築しておくこと (README / docs/deploy.md 参照)。
#
#   DEPLOY_HOST=root@172.104.89.28 SSH_KEY=~/.ssh/linode.com deploy/deploy.sh
#   PROTO_HOST=example.com PROTO_USER=root SSH_KEY=~/.ssh/<鍵> deploy/deploy.sh
#
# クライアント (Vite) と Elixir release だけを転送する。アプリのソースツリーや node_modules は
# VPS に置かない (Elixir release は自己完結している)。
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

echo "==> build server (Elixir release)"
(
  cd apps/server
  MIX_ENV=prod mix deps.get --only prod
  MIX_ENV=prod mix release --overwrite
)

RELEASE_DIR="apps/server/_build/prod/rel/proto_server"
test -x "$RELEASE_DIR/bin/proto_server" || {
  echo "release not found: $RELEASE_DIR" >&2
  exit 1
}

echo "==> prepare remote directories and keep previous versions"
"${SSH[@]}" "$DEPLOY_HOST" bash -s <<'EOF'
set -euo pipefail
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
fi
EOF

echo "==> upload client"
RSYNC=(rsync -az --delete --chown=proto:proto -e "${SSH[*]}")
"${RSYNC[@]}" apps/client/dist/ "$DEPLOY_HOST:/srv/proto-client/"

echo "==> upload release"
"${RSYNC[@]}" "$RELEASE_DIR/" "$DEPLOY_HOST:/opt/proto/app/apps/server/_build/prod/rel/proto_server/"

echo "==> restart proto-server (Kubo は再起動しない)"
"${SSH[@]}" "$DEPLOY_HOST" bash -s <<'EOF'
set -euo pipefail
systemctl is-active --quiet kubo || echo "WARNING: kubo.service is not active (IPFS の取得・pin は失敗する)"
systemctl restart proto-server
sleep 4
systemctl is-active proto-server
journalctl -u proto-server -n 12 --no-pager -o cat
EOF
echo "==> done"
