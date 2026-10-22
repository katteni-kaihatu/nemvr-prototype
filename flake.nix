{
  description = "VR SNS prototype - Elixir/OTP server development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              elixir
              kubo
              nodejs
              pnpm
              git
              curl
              jq

              # Bevy / native client
              rustup
              gcc
              pkg-config
              cmake
              python3
              clang
              lld
              alsa-lib
              udev
              vulkan-loader
              libxkbcommon
              xkeyboard-config
              wayland
              libX11
              libXcursor
              libXi
              libXrandr
              libXinerama
              fontconfig
              freetype
              openssl
              ffmpeg
              openxr-loader
              patchelf
              squashfsTools
              file
              zip
            ];

            shellHook = ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [
                alsa-lib
                udev
                vulkan-loader
                libxkbcommon
                wayland
                libX11
                libXcursor
                libXi
                libXrandr
                libXinerama
                fontconfig
                freetype
                openssl
                ffmpeg
                openxr-loader
                stdenv.cc.cc.lib
              ])}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

              export XKB_CONFIG_ROOT="${pkgs.xkeyboard-config}/share/X11/xkb"

              echo "proto_server - Elixir/OTP development shell"
              echo "  Elixir:  $(elixir --version | tail -n 1)"
              echo "  Mix:     $(mix --version | tail -n 1)"
              echo "  kubo:    $(ipfs version 2>/dev/null || echo 'ipfs not found on PATH')"
              echo "  node:    $(node --version)"
              echo "  pnpm:    $(pnpm --version)"
              echo ""
              echo "  Native client (Rust 1.95+):"
              echo "  rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy"
              echo "  rustup run 1.95.0 cargo test --workspace"
              echo "  rustup run 1.95.0 cargo run -p proto-client"
              echo "  bash scripts/package-linux.sh   # AppImage"
              echo "  nix develop .#windows          # then: bash scripts/package-windows.sh"
              echo ""
              echo "  cd apps/server"
              echo "  mix local.hex --force && mix deps.get"
              echo "  mix compile"
              echo "  mix test"
              echo "  mix run --no-halt   # HTTP + WebSocket on HOST:PORT"
              echo ""
              echo "Run the deps fetch once; afterwards the Nix shell is enough."
              echo "Kubo runs separately: ipfs daemon (API :5001, Gateway :8082, libp2p ws :8081)."
              echo "See docs/otp-backend.md for the interface contract."
            '';
          };

          windows = pkgs.mkShell {
            packages = with pkgs; [
              rustup
              gcc
              pkg-config
              zip
              pkgs.pkgsCross.mingwW64.stdenv.cc
            ];

            shellHook = ''
              echo "proto_client - Windows cross-compile shell"
              echo "  bash scripts/package-windows.sh"
            '';
          };
        });
    };
}
