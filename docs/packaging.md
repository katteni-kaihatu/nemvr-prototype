# Linux / Windows パッケージ

ネイティブクライアントを単体で起動できる形にまとめる。

## 成果物

```text
dist/ProtoSNS-x86_64.AppImage          Linux (AppImage, 約 38 MB)
dist/ProtoSNS-x86_64.AppImage.sha256
dist/ProtoSNS-windows-x86_64.zip       Windows (zip, 約 35 MB)
dist/ProtoSNS-windows-x86_64.zip.sha256
```

`dist/` は `.gitignore` の対象で、リポジトリにはコミットしない。

## Linux (AppImage)

### ビルド

```sh
nix develop
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
bash scripts/package-linux.sh
```

すでに `target/release/proto-client` がある場合はビルドを省略できる。

```sh
bash scripts/package-linux.sh --no-build
```

スクリプトの処理:

1. `cargo build --release -p proto-client`
2. `dist/ProtoSNS.AppDir` を作成
3. `ldd` で必要な共有ライブラリを収集
   - glibc と `ld-linux-x86-64.so.2`
   - `libwayland-client`, `libasound`, `libudev`, `libffi`, `libgcc_s`
   - `libnss_*`, `libresolv`, `libanl`
4. `patchelf` で RUNPATH を `$ORIGIN` 基準に変更
5. `assets/AppRun` を配置し、同梱した loader で起動するようにする
6. AppImage 化

`appimagetool` は初回だけ `.cache/` にダウンロードする。
ダウンロード物は SHA-256 で検証する。AppImage 化に失敗した場合は
`dist/ProtoSNS-linux-x86_64.tar.gz` をフォールバックとして作る。

### 実行

```sh
chmod +x dist/ProtoSNS-x86_64.AppImage
./dist/ProtoSNS-x86_64.AppImage
```

NixOS など FUSE が無効な環境では、抽出実行を使う。

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./dist/ProtoSNS-x86_64.AppImage
# または
nix run nixpkgs#appimage-run -- ./dist/ProtoSNS-x86_64.AppImage
```

AppDir のまま起動することもできる。

```sh
./dist/ProtoSNS.AppDir/AppRun
```

確認:

```sh
./dist/ProtoSNS-x86_64.AppImage --help
APPIMAGE_EXTRACT_AND_RUN=1 ./dist/ProtoSNS-x86_64.AppImage \
  --headless --server ws://127.0.0.1:8080/ws --name packaged --duration 3
```

この環境では次を確認済み。

- `--help` が AppImage から直接実行できる
- headless でサーバーに入室し、`space_welcome` を受け取る
- Xvfb + llvmpipe (Vulkan) でウィンドウ生成と描画初期化まで進む
- Weston headless (Wayland) で `libxkbcommon` をロードし、ウィンドウ生成まで進む
- `sha256sum -c` が通る

物理 GPU 上での描画と SteamVR は未検証。

### 前提

- x86_64 Linux (glibc)
- Vulkan ドライバ (wgpu が使用)
- X11 または Wayland のクライアントライブラリ
- 音声を使う場合は ALSA
- 直接実行する場合は FUSE。抽出実行なら不要

Wayland クライアント、ALSA、udev、glibc、`libxkbcommon`、`xkeyboard-config`、
Vulkan ローダ、日本語 UI フォントを同梱する。GPU ドライバ (ICD) と X11 ライブラリはホストのものを使う。
GPU ドライバを同梱するとカーネルドライバと不整合を起こすため、意図的に含めていない。
AppRun は `XKB_CONFIG_ROOT` を同梱データへ向け、`VK_ICD_FILENAMES` を
`/run/opengl-driver`、`/run/current-system/sw`、`/usr/share/vulkan` などから自動設定する。

### Wayland で起動しない場合

以前の AppImage は `libxkbcommon.so.0` とキーマップデータを含んでおらず、
Wayland で次のように失敗していた。

```text
xkbcommon_dl: Failed loading `libxkbcommon.so.0`
panicked at ... XKBNotFound
```

現在のビルドは `libxkbcommon.so.0`、`libxkbcommon-x11.so.0`、`xkeyboard-config` を
同梱し、`XKB_CONFIG_ROOT` を設定する。古い AppImage を使っている場合は再ビルドする。

```sh
bash scripts/package-linux.sh --no-build
```

`Unable to find a GPU` が出る場合は、Vulkan ICD が見つかっていない。
NixOS では `/run/opengl-driver/share/vulkan/icd.d` を確認するか、明示的に指定する。

```sh
VK_ICD_FILENAMES=/run/opengl-driver/share/vulkan/icd.d/lvp_icd.x86_64.json \
  ./dist/ProtoSNS-x86_64.AppImage
```

## Windows (zip)

### ビルド

Linux 上で MinGW-w64 向けにクロスコンパイルする。

```sh
nix develop .#windows
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
bash scripts/package-windows.sh
```

既存の exe を使う場合:

```sh
bash scripts/package-windows.sh --no-build
```

スクリプトの処理:

1. `rustup target add x86_64-pc-windows-gnu`
2. MinGW-w64 の mcfgthread を `libpthread.a` として見えるようにする
   - Rust の `windows-gnu` std が `-l:libpthread.a` を要求するため
   - Nix の MinGW-w64 は winpthreads ではなく mcfgthread を使う
3. `cargo build --release --target x86_64-pc-windows-gnu -p proto-client`
4. `dist/ProtoSNS-windows-x86_64/` に exe と README を入れて zip 化

Windows 側の実行時 DLL は Windows のシステム DLL のみ。
MinGW のランタイム DLL は同梱不要 (静的リンク)。

### 実行

zip を展開し、`ProtoSNS-windows-x86_64\proto-client.exe` を実行する。

```bat
proto-client.exe --server ws://127.0.0.1:8080/ws
proto-client.exe --server ws://127.0.0.1:8080/ws --name alice
proto-client.exe --headless --server ws://127.0.0.1:8080/ws --name test --duration 3
```

設定は `%APPDATA%\proto\proto-client\config.json`、キャッシュ / IPFS は
`%LOCALAPPDATA%\proto\proto-client\` に保存される。

### 前提と制限

- Windows 10 / 11 (64-bit)
- Vulkan または DirectX 12 の GPU ドライバ
- コード署名なし。SmartScreen の警告が出る場合がある
- インストーラ、自動更新、Windows 用アイコンは未対応
- Wine 上で `--help`、headless 入室、`--ipfs-smoke` の起動を確認済み
- 実機 Windows の GPU / 音声 / IME / SteamVR は未検証
- VRM / XR / 動画は未実装

## UI のトラブルシューティング

- 日本語が豆腐 (□) になる場合は、古い AppImage / exe を使っている可能性がある。
  現在のビルドは Migu 1M を実行ファイルに埋め込んでいる。
- Lobby の緑色の「接続」ボタンを押しても何も起きない場合は、ボタンの下の
  接続状態を確認する。接続先は Lobby で編集できる。
  サーバーが起動していない場合は「接続できません」と表示される。

## 共通の既知の制限

- Linux AppImage は glibc 2.42 を同梱している。非常に古いディストリビューションや、
  ホストの NSS / グラフィックスドライバとの組み合わせで問題が出る可能性がある。
  その場合は同梱の `usr/lib/libc.so.6` などを外し、ホストの glibc を使う。
- 同梱する glibc / ALSA / Wayland などのライセンス条件は、配布前に確認する。
- AppImage の署名、自動更新、デスクトップ統合は未対応。
- `appimagetool` は continuous ビルドを使う。スクリプト内で SHA-256 を固定している。
- AppImage 化にはネットワークが必要 (appimagetool のダウンロードと runtime 取得)。

## ファイル

```text
assets/AppRun                  AppImage の起動スクリプト
assets/proto-sns.desktop      デスクトップエントリ
assets/proto-sns.svg          アイコン
assets/proto-sns.appdata.xml  AppStream メタデータ
assets/README-windows.txt     Windows zip の README
assets/fonts/migu-1m-regular.ttf  日本語 UI フォント (Migu 1M)
assets/fonts/LICENSE-migu.txt     フォントのライセンス表示
scripts/package-linux.sh      Linux AppImage のビルド
scripts/package-windows.sh    Windows zip のビルド
.cargo/config.toml            Windows GNU ターゲットのリンカ設定
```