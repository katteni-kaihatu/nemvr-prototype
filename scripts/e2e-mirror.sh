#!/usr/bin/env bash
# 鏡の起動を E2E で確認する。
#
# 前提:
#   - サーバーが起動していること
#   - グラフィカルセッション (DISPLAY または WAYLAND_DISPLAY) があること
#   - `pnpm build:native` 済み
#
#   pnpm e2e:mirror
#   WS_URL=wss://nemvr.nemnomi.dev/ws pnpm e2e:mirror
#   AVATAR=~/avatar.vrm pnpm e2e:mirror
#
# 確認内容:
#   - クライアントが --mirror で起動する
#   - Bevy が PNG スクリーンショットを書き出す
#   - ログに "self-view mirror enabled" が出る
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${PROTO_CLIENT:-$ROOT/target/release/proto-client}"
WS_URL="${WS_URL:-ws://127.0.0.1:8080/ws}"
OUT="${SCREENSHOT:-/tmp/proto-mirror.png}"
LOG="${MIRROR_LOG:-/tmp/proto-mirror.log}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ ! -x "$BIN" ]]; then
  echo "missing $BIN; run 'pnpm build:native'" >&2
  exit 1
fi
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  echo "DISPLAY または WAYLAND_DISPLAY が必要です" >&2
  exit 1
fi

rm -f "$OUT" "$LOG"
args=(
  --server "$WS_URL"
  --name e2e-mirror
  --mirror
  --screenshot "$OUT"
)
if [[ -n "${AVATAR:-}" ]]; then
  args+=(--avatar "$AVATAR")
fi

XDG_CONFIG_HOME="$TMP/config" XDG_CACHE_HOME="$TMP/cache" \
  RUST_LOG=proto_client=info,bevy=warn \
  timeout 30s "$BIN" "${args[@]}" >"$LOG" 2>&1 &
pid=$!

for _ in $(seq 1 25); do
  [[ -s "$OUT" ]] && break
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if [[ ! -s "$OUT" ]]; then
  echo "スクリーンショットが生成されませんでした:" >&2
  tail -30 "$LOG" >&2
  exit 1
fi
if ! grep -q "self-view mirror enabled" "$LOG"; then
  echo "鏡が有効化されませんでした:" >&2
  tail -30 "$LOG" >&2
  exit 1
fi

python3 - "$OUT" <<'PY'
import struct, sys
path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read(24)
if data[:8] != b"\x89PNG\r\n\x1a\n":
    raise SystemExit(f"not a PNG: {path}")
width, height = struct.unpack(">II", data[16:24])
if width < 640 or height < 360:
    raise SystemExit(f"screenshot too small: {width}x{height}")
print(f"mirror screenshot: {path} ({width}x{height})")
PY

echo "E2E MIRROR OK"
echo "  screenshot: $OUT"
echo "  log:        $LOG"