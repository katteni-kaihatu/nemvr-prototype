#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
BUNDLE="$DIST/ProtoSNS-windows-x86_64"
TARGET="x86_64-pc-windows-gnu"
BIN="$ROOT/target/$TARGET/release/proto-client.exe"
ZIP="$DIST/ProtoSNS-windows-x86_64.zip"
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-1.95.0}"

build=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    -h|--help)
      echo "usage: $0 [--no-build]"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "$build" == 1 ]]; then
  if ! command -v rustup >/dev/null 2>&1; then
    echo "rustup is required. Run this script inside 'nix develop .#windows'." >&2
    exit 1
  fi
  if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
    echo "x86_64-w64-mingw32-gcc is required. Run this script inside 'nix develop .#windows'." >&2
    exit 1
  fi

  rustup target add "$TARGET" --toolchain "$RUST_TOOLCHAIN"

  # Nix の MinGW-w64 は winpthreads ではなく mcfgthread を使う。
  # Rust の windows-gnu std は libpthread.a を要求するため、静的ライブラリを
  # その名前で見えるようにしてリンクする。winpthreads がある環境では不要。
  WIN_LINK="$ROOT/target/win-link"
  mkdir -p "$WIN_LINK"
  PTHREAD="$(x86_64-w64-mingw32-gcc -print-file-name=libpthread.a)"
  if [[ ! -f "$PTHREAD" ]]; then
    MCFG=""
    if command -v nix-store >/dev/null 2>&1; then
      while IFS= read -r package; do
        if [[ -f "$package/lib/libmcfgthread.a" ]]; then
          MCFG="$package/lib/libmcfgthread.a"
          break
        fi
      done < <(nix-store -qR "$(readlink -f "$(command -v x86_64-w64-mingw32-gcc)")")
    fi
    if [[ -z "$MCFG" ]]; then
      MCFG="$(x86_64-w64-mingw32-gcc -print-file-name=libmcfgthread.a)"
    fi
    if [[ ! -f "$MCFG" ]]; then
      echo "neither libpthread.a nor libmcfgthread.a was found in the MinGW toolchain" >&2
      exit 1
    fi
    ln -sf "$MCFG" "$WIN_LINK/libpthread.a"
  fi

  CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="-L $WIN_LINK" \
    rustup run "$RUST_TOOLCHAIN" cargo build --release --target "$TARGET" -p proto-client
fi

if [[ ! -f "$BIN" ]]; then
  echo "missing $BIN; run without --no-build" >&2
  exit 1
fi

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
cp "$BIN" "$BUNDLE/proto-client.exe"
cp "$ROOT/assets/README-windows.txt" "$BUNDLE/README.txt"
chmod +x "$BUNDLE/proto-client.exe"

rm -f "$ZIP"
(cd "$DIST" && zip -9 -r "ProtoSNS-windows-x86_64.zip" "ProtoSNS-windows-x86_64")
(cd "$DIST" && sha256sum "ProtoSNS-windows-x86_64.zip" > "ProtoSNS-windows-x86_64.zip.sha256")

echo "created $ZIP"
ls -lh "$ZIP" "$ZIP.sha256"