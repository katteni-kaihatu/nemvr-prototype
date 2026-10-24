#!/usr/bin/env bash
# Official Godot WebRTC GDExtension (libdatachannel) for non-web exports.
set -euo pipefail
cd "$(dirname "$0")/.."
project="apps/godot-client"
destination="$project/addons/webrtc_native"
if [ -f "$project/webrtc_native.gdextension" ]; then
  exit 0
fi
version="1.2.2-stable"
archive="$(mktemp --suffix=.zip)"
trap 'rm -f "$archive"' EXIT
curl -fsSL --retry 3 \
  "https://github.com/godotengine/webrtc-native/releases/download/${version}/godot-extension-webrtc_native.zip" \
  -o "$archive"
echo "98e9446921740d995bd9ca1be48798dc3c2ceed51e044a25ce18b3cff11f56e5  $archive" | sha256sum -c -
mkdir -p "$project"
python3 -m zipfile -e "$archive" "$project"
# Godot exports GDExtension libraries next to the executable. Keep the
# manifest at the project root and use root-relative x86_64 paths.
python3 - <<'PY'
from pathlib import Path
import shutil
project = Path("apps/godot-client")
source = project / "addons/webrtc_native"
manifest = (source / "webrtc_native.gdextension").read_text()
manifest = manifest.replace("lib/libwebrtc_native.", "libwebrtc_native.")
(project / "webrtc_native.gdextension").write_text(manifest)
(source / "webrtc_native.gdextension").unlink(missing_ok=True)
for name in [
    "libwebrtc_native.linux.template_debug.x86_64.so",
    "libwebrtc_native.linux.template_release.x86_64.so",
    "libwebrtc_native.windows.template_debug.x86_64.dll",
    "libwebrtc_native.windows.template_release.x86_64.dll",
]:
    shutil.copy2(source / "lib" / name, project / name)
PY
