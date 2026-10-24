#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v go >/dev/null 2>&1; then
  (cd apps/voice && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o voice .)
else
  nix shell nixpkgs#go nixpkgs#gcc -c bash -lc 'cd apps/voice && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o voice .'
fi
