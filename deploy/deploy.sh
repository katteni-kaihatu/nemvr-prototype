#!/usr/bin/env bash
# 手元のリポジトリを VPS に反映する (ビルド → 転送 → 依存導入 → 再起動)。
# 初回は先に deploy/setup-vps.sh で VPS を構築しておくこと (README / docs/deploy.md 参照)。
#
#   DEPLOY_HOST=root@172.104.89.28 SSH_KEY=~/.ssh/linode.com deploy/deploy.sh
set -euo pipefail

: "${DEPLOY_HOST:?DEPLOY_HOST (例: root@172.104.89.28) を指定してください}"
SSH_KEY="${SSH_KEY:-}"
SSH=(ssh -o BatchMode=yes)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

cd "$(dirname "$0")/.."

echo "==> build"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @proto/client build

echo "==> upload"
RSYNC=(rsync -az --delete --chown=proto:proto -e "${SSH[*]}")
# サーバーの実行に必要なもの (client のソースも lockfile の整合のため含める)。node_modules は VPS 側で入れる
"${RSYNC[@]}" \
  --exclude node_modules --exclude .git --exclude dist --exclude '*.log' \
  ./ "$DEPLOY_HOST:/opt/proto/app/"
# ビルド済みクライアントは Caddy が配信する
"${RSYNC[@]}" apps/client/dist/ "$DEPLOY_HOST:/srv/proto-client/"

echo "==> install and restart"
"${SSH[@]}" "$DEPLOY_HOST" bash -s <<'EOF'
set -euo pipefail
runuser -u proto -- bash -c 'cd /opt/proto/app && pnpm install --frozen-lockfile --filter "@proto/server..." 2>&1 | tail -3'
systemctl restart proto-server
sleep 4
systemctl is-active proto-server
journalctl -u proto-server -n 8 --no-pager -o cat
EOF
echo "==> done"
