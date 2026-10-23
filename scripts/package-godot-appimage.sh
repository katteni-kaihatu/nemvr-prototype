#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:?usage: package-godot-appimage.sh <exported-directory> [output.AppImage]}"
DIST="$ROOT/dist"
APP="$DIST/ProtoSNS-godot.AppDir"
OUT="${2:-$DIST/ProtoSNS-godot-x86_64.AppImage}"
TOOL="$ROOT/.cache/appimagetool-x86_64.AppImage"
TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
TOOL_SHA256="95cbe7cce9717fce90c484e34052ee7c7f1d7635b33c12525b4776826a7d29b6"

BIN="$SOURCE/ProtoSNS-godot.x86_64"
PCK="$SOURCE/ProtoSNS-godot.pck"
LIB="$SOURCE/libproto_godot.so"
for file in "$BIN" "$PCK" "$LIB"; do
  if [[ ! -f "$file" ]]; then
    echo "missing export file: $file" >&2
    exit 1
  fi
done

rm -rf "$APP"
mkdir -p \
  "$APP/usr/bin" \
  "$APP/usr/lib" \
  "$APP/usr/share/applications" \
  "$APP/usr/share/icons/hicolor/scalable/apps" \
  "$APP/usr/share/metainfo" \
  "$APP/usr/share/licenses/proto-sns"

cp "$BIN" "$PCK" "$LIB" "$APP/usr/bin/"
cp -r "$SOURCE/licenses/." "$APP/usr/share/licenses/proto-sns/"
cp "$ROOT/assets/proto-sns.svg" "$APP/usr/share/icons/hicolor/scalable/apps/proto-sns.svg"
cp "$ROOT/assets/proto-sns-godot.desktop" "$APP/usr/share/applications/proto-sns.desktop"
cp "$ROOT/assets/proto-sns.appdata.xml" "$APP/usr/share/metainfo/proto-sns.appdata.xml"
cp "$ROOT/assets/proto-sns-godot.desktop" "$APP/proto-sns.desktop"
cp "$ROOT/assets/proto-sns.svg" "$APP/proto-sns.svg"
ln -sf proto-sns.svg "$APP/.DirIcon"
chmod +x "$APP/usr/bin/ProtoSNS-godot.x86_64" "$APP/usr/bin/libproto_godot.so"

is_system_lib() {
  case "$(basename "$1")" in
    ld-linux*|libc.so*|libm.so*|libmvec.so*|libpthread.so*|librt.so*|libdl.so*|libnss_*|libresolv.so*|libanl.so*|libutil.so*|libthread_db.so*) return 0 ;;
  esac
  return 1
}
while IFS= read -r line; do
  [[ "$line" == *"=>"* ]] || continue
  path="${line#*=> }"
  path="${path%% (*}"
  [[ -n "$path" && -f "$path" ]] || continue
  # The AppImage relies on the host glibc and its loader. Bundling them mixes
  # two C runtimes and has caused stack protector aborts with host GPU libs.
  is_system_lib "$path" && continue
  base="$(basename "$path")"
  # The executable and the extension share most dependencies. Nix store
  # copies are read-only, so never copy the same SONAME twice.
  [[ -e "$APP/usr/lib/$base" ]] && continue
  cp -L "$path" "$APP/usr/lib/$base"
done < <(ldd "$APP/usr/bin/ProtoSNS-godot.x86_64"; ldd "$APP/usr/bin/libproto_godot.so")

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
  copy_optional_lib "$name" || true
done
if [[ ! -f "$APP/usr/lib/libxkbcommon.so.0" ]]; then
  echo "libxkbcommon.so.0 was not found; Wayland startup would fail" >&2
  exit 1
fi

# Godot loads X11 / Wayland backends with dlopen, so they do not appear in
# ldd of the executable. Bundle them explicitly for NixOS and minimal hosts.
for name in \
  libX11.so.6 libX11-xcb.so.1 libXcursor.so.1 libXrandr.so.2 \
  libXinerama.so.1 libXi.so.6 libXext.so.6 libXrender.so.1 libXfixes.so.3 \
  libxcb.so.1 libXau.so.6 libXdmcp.so.6 \
  libwayland-client.so.0 libwayland-cursor.so.0 libwayland-egl.so.1; do
  copy_optional_lib "$name" || true
done

# Copy the transitive closure of the newly bundled backend libraries.
for _ in 1 2 3 4 5; do
  changed=0
  while IFS= read -r line; do
    [[ "$line" == *"=>"* ]] || continue
    path="${line#*=> }"
    path="${path%% (*}"
    [[ -n "$path" && -f "$path" ]] || continue
    is_system_lib "$path" && continue
    base="$(basename "$path")"
    [[ "$base" == ld-linux* ]] && continue
    [[ -e "$APP/usr/lib/$base" ]] && continue
    cp -L "$path" "$APP/usr/lib/$base"
    chmod u+w "$APP/usr/lib/$base"
    changed=1
  done < <(for lib in "$APP"/usr/lib/*.so*; do ldd "$lib" 2>/dev/null || true; done)
  [[ "$changed" == 0 ]] && break
done

for required in libX11.so.6 libwayland-client.so.0; do
  if [[ ! -f "$APP/usr/lib/$required" ]]; then
    echo "$required was not found; graphical startup would fail" >&2
    exit 1
  fi
done

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
cp "$ROOT/assets/AppRun-godot" "$APP/AppRun"
chmod +x "$APP/AppRun"

mkdir -p "$ROOT/.cache"
rm -f "$OUT"
if [[ ! -x "$TOOL" ]]; then
  echo "downloading appimagetool..."
  curl -L --fail --output "$TOOL.tmp" "$TOOL_URL"
  echo "$TOOL_SHA256  $TOOL.tmp" | sha256sum -c -
  mv "$TOOL.tmp" "$TOOL"
  chmod +x "$TOOL"
fi

APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$TOOL" "$APP" "$OUT"
chmod +x "$OUT"
node "$ROOT/scripts/smoke-godot-linux.mjs" "$OUT"
(cd "$DIST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
echo "created $OUT"
ls -lh "$OUT" "$OUT.sha256"
