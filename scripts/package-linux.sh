#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/ProtoSNS.AppDir"
OUT="$DIST/ProtoSNS-x86_64.AppImage"
TOOL="$ROOT/.cache/appimagetool-x86_64.AppImage"
TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
TOOL_SHA256="95cbe7cce9717fce90c484e34052ee7c7f1d7635b33c12525b4776826a7d29b6"
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
    echo "rustup is required. Run this script inside 'nix develop'." >&2
    exit 1
  fi
  (cd "$ROOT" && rustup run "$RUST_TOOLCHAIN" cargo build --release -p proto-client)
fi

BIN="$ROOT/target/release/proto-client"
if [[ ! -x "$BIN" ]]; then
  echo "missing $BIN; run without --no-build" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p \
  "$APP/usr/bin" \
  "$APP/usr/lib" \
  "$APP/usr/share/applications" \
  "$APP/usr/share/icons/hicolor/scalable/apps" \
  "$APP/usr/share/metainfo"

cp "$BIN" "$APP/usr/bin/proto-client"
cp "$ROOT/assets/proto-sns.svg" "$APP/usr/share/icons/hicolor/scalable/apps/proto-sns.svg"
cp "$ROOT/assets/proto-sns.desktop" "$APP/usr/share/applications/proto-sns.desktop"
cp "$ROOT/assets/proto-sns.appdata.xml" "$APP/usr/share/metainfo/proto-sns.appdata.xml"
cp "$ROOT/assets/proto-sns.desktop" "$APP/proto-sns.desktop"
cp "$ROOT/assets/proto-sns.svg" "$APP/proto-sns.svg"
ln -sf proto-sns.svg "$APP/.DirIcon"
chmod +x "$APP/usr/bin/proto-client"

loader=""
libc_dir=""
while IFS= read -r line; do
  [[ "$line" == *"=>"* ]] || continue
  path="${line#*=> }"
  path="${path%% (*}"
  [[ -n "$path" && -f "$path" ]] || continue
  base="$(basename "$path")"
  if [[ "$base" == ld-linux* ]]; then
    loader="$path"
    continue
  fi
  if [[ "$base" == libc.so.6 ]]; then
    libc_dir="$(dirname "$path")"
  fi
  cp -L "$path" "$APP/usr/lib/$base"
done < <(ldd "$BIN")

if [[ -n "$loader" ]]; then
  cp -L "$loader" "$APP/usr/lib/$(basename "$loader")"
fi

if [[ -n "$libc_dir" ]]; then
  for extra in "$libc_dir"/libnss_*.so* "$libc_dir"/libresolv.so* "$libc_dir"/libanl.so*; do
    [[ -f "$extra" ]] || continue
    cp -L "$extra" "$APP/usr/lib/$(basename "$extra")"
  done
fi

# Wayland / X11 の入力に必要。ホストに無い NixOS でも動くように同梱する。
copy_optional_lib() {
  local name="$1"
  local dir
  local IFS=:
  for dir in ${LD_LIBRARY_PATH:-}; do
    if [[ -f "$dir/$name" ]]; then
      cp -L "$dir/$name" "$APP/usr/lib/$name"
      return 0
    fi
  done
  return 1
}

for name in libxkbcommon.so.0 libxkbcommon-x11.so.0; do
  if ! copy_optional_lib "$name"; then
    xkb_lib_dir="$(pkg-config --variable=libdir xkbcommon 2>/dev/null || true)"
    if [[ -n "$xkb_lib_dir" && -f "$xkb_lib_dir/$name" ]]; then
      cp -L "$xkb_lib_dir/$name" "$APP/usr/lib/$name"
    fi
  fi
done

if [[ ! -f "$APP/usr/lib/libxkbcommon.so.0" ]]; then
  echo "libxkbcommon.so.0 was not found; Wayland startup would fail" >&2
  exit 1
fi

# Vulkan ローダを同梱する。ホストの NVIDIA / Mesa ドライバ (ICD) は
# AppRun が検出して VK_ICD_FILENAMES に設定する。
if ! copy_optional_lib libvulkan.so.1; then
  vulkan_lib_dir="$(pkg-config --variable=libdir vulkan 2>/dev/null || true)"
  if [[ -n "$vulkan_lib_dir" && -f "$vulkan_lib_dir/libvulkan.so.1" ]]; then
    cp -L "$vulkan_lib_dir/libvulkan.so.1" "$APP/usr/lib/libvulkan.so.1"
  elif command -v nix >/dev/null 2>&1; then
    vulkan_lib_dir="$(nix build --no-link --print-out-paths nixpkgs#vulkan-loader 2>/dev/null)/lib"
    [[ -f "$vulkan_lib_dir/libvulkan.so.1" ]] && cp -L "$vulkan_lib_dir/libvulkan.so.1" "$APP/usr/lib/libvulkan.so.1"
  fi
fi

if [[ ! -f "$APP/usr/lib/libvulkan.so.1" ]]; then
  echo "libvulkan.so.1 was not found; the client would not find a GPU" >&2
  exit 1
fi

# xkbcommon はキーマップをデータファイルから読む。XKB_CONFIG_ROOT を
# 同梱データへ向けないと、NixOS では XKBNotFound で落ちる。
xkb_data="${XKB_CONFIG_ROOT:-}"
if [[ -z "$xkb_data" ]]; then
  for candidate in /nix/store/*-xkeyboard-config-*/share/X11/xkb; do
    if [[ -d "$candidate" ]]; then
      xkb_data="$candidate"
      break
    fi
  done
fi
if [[ -z "$xkb_data" ]] && command -v nix >/dev/null 2>&1; then
  xkb_data="$(nix build --no-link --print-out-paths nixpkgs#xkeyboard-config 2>/dev/null)/share/X11/xkb"
fi
if [[ ! -d "$xkb_data" ]]; then
  echo "xkeyboard-config data was not found; Wayland startup would fail" >&2
  exit 1
fi
mkdir -p "$APP/usr/share/X11"
cp -rL "$xkb_data" "$APP/usr/share/X11/xkb"

chmod -R u+w "$APP/usr/lib" "$APP/usr/share/X11/xkb"
cp "$ROOT/assets/AppRun" "$APP/AppRun"
chmod +x "$APP/AppRun"

is_elf() {
  [[ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" == "7f454c46" ]]
}

patchelf --set-rpath '$ORIGIN/../lib' "$APP/usr/bin/proto-client"
for lib in "$APP/usr/lib"/*; do
  base="$(basename "$lib")"
  [[ "$base" == ld-linux* ]] && continue
  is_elf "$lib" || continue
  patchelf --set-rpath '$ORIGIN' "$lib"
done

mkdir -p "$ROOT/.cache"
rm -f "$OUT"
if [[ ! -x "$TOOL" ]]; then
  echo "downloading appimagetool..."
  curl -L --fail --output "$TOOL.tmp" "$TOOL_URL"
  echo "$TOOL_SHA256  $TOOL.tmp" | sha256sum -c -
  mv "$TOOL.tmp" "$TOOL"
  chmod +x "$TOOL"
fi

if APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$TOOL" "$APP" "$OUT"; then
  chmod +x "$OUT"
  APPIMAGE_EXTRACT_AND_RUN=1 "$OUT" --help >/dev/null
  (cd "$DIST" && sha256sum "ProtoSNS-x86_64.AppImage" > "ProtoSNS-x86_64.AppImage.sha256")
  echo "created $OUT"
  ls -lh "$OUT" "$OUT.sha256"
else
  echo "appimagetool failed; creating a portable tarball instead" >&2
  tar -C "$DIST" -czf "$DIST/ProtoSNS-linux-x86_64.tar.gz" ProtoSNS.AppDir
  (cd "$DIST" && sha256sum "ProtoSNS-linux-x86_64.tar.gz" > "ProtoSNS-linux-x86_64.tar.gz.sha256")
  echo "created $DIST/ProtoSNS-linux-x86_64.tar.gz"
  ls -lh "$DIST/ProtoSNS-linux-x86_64.tar.gz"
  exit 1
fi