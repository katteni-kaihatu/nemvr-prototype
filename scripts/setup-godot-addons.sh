#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit=e15199f980064028bfa4fbee5e70dddb82dd55c3
sha256=7231d036fac12389791762b8e6760ebbc074fe9d2fce06f8dc184dec0e8aec85
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --location --retry 3 "https://codeload.github.com/V-Sekai/godot-vrm/tar.gz/$commit" --output "$temporary/addons.tar.gz"
printf '%s  %s\n' "$sha256" "$temporary/addons.tar.gz" | sha256sum --check --status
# The pinned archive contains both addons and their licenses. No editor enablement.
tar -xzf "$temporary/addons.tar.gz" --strip-components=1 -C "$root/apps/godot-client" "godot-vrm-$commit/addons/vrm" "godot-vrm-$commit/addons/Godot-MToon-Shader"
