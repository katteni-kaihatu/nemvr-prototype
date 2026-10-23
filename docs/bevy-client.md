# Bevy ネイティブクライアント (比較用)

> **2026-10-23: Linux の既定は Godot 版 (`apps/godot-client`) に切り替えた。**
> Bevy 版は比較用に残しており、Windows の実機確認が終わるまで
> `pnpm package:windows` はこの実装をビルドする。詳細は
> [`godot-client.md`](godot-client.md) を参照。

`apps/client` は、既存の Elixir / space v2 / Kubo 構成に接続する Bevy クライアント。
Linux の通常起動は `pnpm dev:client` (Godot)、Bevy は `pnpm dev:bevy` で起動する。

## 現在の状態

| 領域 | 状態 |
|---|---|
| space v2 の型・スキーマ・fixture | 実装済み (`crates/space-protocol`) |
| WebSocket 入室・ping・再接続・再購読 | 実装済み |
| SpaceStore / delta 適用 / 投影 | 実装済み |
| デスクトップ移動・衝突・リーン・しゃがみ | 実装済み |
| 他ユーザーの補間・簡易アバター | 実装済み |
| 画像・ファイル・ボックス・リンク表示 | 実装済み (画像は IPFS / HTTP) |
| ドラッグ&ドロップ配置 | 実装済み |
| つかむ・移動・回転・拡大・離す | 実装済み |
| 削除・複製・ダウンロード | 実装済み (リングメニュー) |
| 埋め込み IPFS (rust-ipfs) | 起動確認済み |
| Kubo との bitswap 相互運用 | TCP 4001 で双方向を確認済み |
| VRM | 0.x を読み込み・表示 (1.0 は簡易アバターにフォールバック) |
| 自分の VRM 表示 | 鏡 (`V`) で表示 |
| VRM のアニメーション | 未実装 (静的なポーズ) |
| OpenXR / PC VR | 未実装 |
| 動画 (FFmpeg) | 未実装 |
| URL 取り込み | 未実装 |
| 鏡 | 実装 (`V` で表示 / 非表示) |
| Linux AppImage | 作成済み (`dist/ProtoSNS-x86_64.AppImage`)。Wayland 起動を修正済み |
| 日本語フォント | Migu 1M をバイナリに埋め込み |
| Lobby | 表示名・接続先の編集、接続中 / エラーの表示 |
| Windows ビルド | クロスビルド済み (`dist/ProtoSNS-windows-x86_64.zip`)。Wine で headless / IPFS を確認 |
| Windows 実機 / SteamVR | 未検証 |

## 起動

```sh
nix develop
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy

# サーバー (別ターミナル)
cd apps/server && mix run --no-halt

# クライアント
rustup run 1.95.0 cargo run -p proto-client -- --server ws://127.0.0.1:8080/ws
```

`--name` を付けると Lobby を飛ばして接続する。

```sh
rustup run 1.95.0 cargo run -p proto-client -- --server ws://127.0.0.1:8080/ws --name alice
```

VRM アバターを指定する場合は `--avatar` を付ける。入室時に IPFS へ追加し、
`space_set_avatar` で他のクライアントへ共有する。Lobby やワールドで `.vrm` を
ウィンドウにドロップしても設定できる。設定は次回起動時に再利用される。

```sh
rustup run 1.95.0 cargo run -p proto-client -- \
  --server wss://nemvr.nemnomi.dev/ws --name alice --avatar ~/avatar.vrm
```

設定は `directories` の `proto-client/config.json` に保存される。
Linux では通常 `~/.config/proto-client/config.json`、キャッシュは `~/.cache/proto-client/`。

## 接続先

| 環境 | サーバー欄に入れる値 |
|---|---|
| ローカル | `ws://127.0.0.1:8080/ws` |
| 開発 VPS | `wss://nemvr.nemnomi.dev/ws` |

Lobby の「サーバー」欄に上の URL を入れ、表示名を入力して「接続」を押す。
起動引数で指定する場合は `--server wss://nemvr.nemnomi.dev/ws` を使う。
VPS では proto-server / Kubo / Caddy が稼働している。

## パッケージ (Linux / Windows)

```sh
nix develop
bash scripts/package-linux.sh     # dist/ProtoSNS-x86_64.AppImage

nix develop .#windows
bash scripts/package-windows.sh   # dist/ProtoSNS-windows-x86_64.zip
```

Linux AppImage にはクライアント本体、glibc、Wayland / ALSA / udev、
`libxkbcommon` / `xkeyboard-config`、Vulkan ローダを含む。
GPU ドライバと X11 ライブラリはホストのものを使う。
NixOS など FUSE が無効な環境では `APPIMAGE_EXTRACT_AND_RUN=1` を付ける。

日本語 UI 用のフォント (Migu 1M, IPA Font License) は実行ファイルに埋め込んでいる。
Lobby では表示名と接続先を編集でき、接続中・失敗理由が緑色のボタンの下に表示される。

Windows 版は MinGW-w64 でクロスコンパイルした `proto-client.exe` を含む zip。
実行時に必要なのは Windows のシステム DLL のみ。コード署名はしていない。

```sh
APPIMAGE_EXTRACT_AND_RUN=1 ./dist/ProtoSNS-x86_64.AppImage --help
```

詳細は [`docs/packaging.md`](packaging.md) を参照。

## 操作

| 操作 | 内容 |
|---|---|
| 左クリック | 視点操作を開始 (ポインタロック) |
| WASD / 矢印 | 移動 |
| Shift | 走る |
| Space | ジャンプ (空中で 1 回まで) |
| C / Ctrl | しゃがみ |
| Q / E | リーン (つかんでいる間の E は回転モード切替) |
| マウス | 視点 |
| 右クリック | 狙っているオブジェクトをつかむ / 離す |
| ホイール | つかんだ距離 |
| Shift + ホイール | つかんだオブジェクトの拡大縮小 |
| E (つかみ中) | 移動 / 回転モード |
| 中クリック / M | リングメニュー (削除 / 複製 / ダウンロード) |
| B | 視線先の床にボックスを置く |
| Esc | ポインタロック解除 / メニューを閉じる |
| ファイルドロップ | 視線先の床に配置 (`.vrm` はアバターとして設定) |
| V | 自分のアバターを見る鏡を表示 / 非表示 |

## ヘッドレス / 検証

```sh
# 入室して welcome を表示
rustup run 1.95.0 cargo run -p proto-client -- \
  --headless --server ws://127.0.0.1:8080/ws --name bot --duration 5

# 入室してボックスを 1 個置く
rustup run 1.95.0 cargo run -p proto-client -- \
  --headless --server ws://127.0.0.1:8080/ws --name bot --scenario place --duration 5

# 埋め込み IPFS の起動確認
rustup run 1.95.0 cargo run -p proto-client -- --ipfs-smoke
```

鏡の E2E は、グラフィカルセッションで `--mirror --screenshot` を付けて起動し、
PNG とログ (`self-view mirror enabled`) を確認する。

```sh
pnpm build:native
pnpm dev   # 別ターミナルでサーバー
pnpm e2e:mirror
```

`AVATAR=~/avatar.vrm pnpm e2e:mirror` で VRM も含めて確認できる。
`SCREENSHOT=/tmp/mirror.png` で保存先を変更できる。

### Kubo との相互運用テスト

Kubo を `127.0.0.1:8081/ws` で起動した状態で、環境変数を使って確認する。

```sh
KUBO_ID=$(IPFS_PATH=/tmp/kubo ipfs id -f '<id>')
KUBO_ADDR="/ip4/127.0.0.1/tcp/8081/ws/p2p/$KUBO_ID"

# ネイティブ -> Kubo (Kubo 側で pin できる)
PROTO_KUBO_ADDR="$KUBO_ADDR" \
PROTO_ADD_FILE=/path/to/file \
PROTO_HOLD_SECS=60 \
  rustup run 1.95.0 cargo run -p proto-client -- --ipfs-smoke

# Kubo -> ネイティブ (Kubo に pin 済みの CID を bitswap で取得)
PROTO_KUBO_ADDR="$KUBO_ADDR" \
PROTO_FETCH_CID=<cid> \
  rustup run 1.95.0 cargo run -p proto-client -- --ipfs-smoke
```

`PROTO_HOLD_SECS` の間に、別のターミナルで `ipfs pin add <cid>` を実行すると、
Kubo がネイティブノードからブロックを取得できることを確認できる。

テスト:

```sh
rustup run 1.95.0 cargo test --workspace
rustup run 1.95.0 cargo clippy --workspace --all-targets -- -D warnings
rustup run 1.95.0 cargo fmt --all -- --check
```

現在のテストは space v2 の wire 形式、fixture、schema、投影、移動、衝突、補間、carry、delta 適用を含む。

## 構成

```text
crates/space-protocol/     space v2 の serde 型、schema の埋め込み、fixture テスト
apps/client/
  src/net/                 WebSocket actor、イベント、SpaceStore、補間
  src/world/               シーン、移動、衝突、carry、アバター、オブジェクト、入力
  src/content/             rust-ipfs / HTTP のコンテンツ取得と追加
  src/ui/                  Lobby、HUD、リングメニュー
  src/headless.rs          E2E / smoke 用の非 GUI クライアント
  src/config.rs            設定と保存先
```

- メインスレッドは Bevy の ECS / 描画。
- WebSocket と IPFS は別スレッドの Tokio ランタイムで動く。
- サーバー状態は `SpaceStore` に保持し、Bevy の `Entity` とは `NetworkId` 相当の文字列で対応させる。
- ローカルの姿勢・carry は即時反映し、サーバーへ 20Hz で patch を送る。
- 他ユーザーは 100ms 遅延で補間する。

## 次の作業

1. **VRM の仕上げ**。歩行・待機アニメーション、VRM 1.0 対応。
2. **OpenXR / PC VR** (`bevy_mod_openxr` 0.6)。HMD 追従、コントローラ線、移動、メニュー。
3. **動画** (`ffmpeg-next` + `/media/<cid>` の Range)。
4. **URL 取り込み**。
5. 画像・ファイルの実ワールドでの表示確認、`Text2d` の 3D 表示確認。
6. キャッシュの上限・eviction、取得キャンセル、進捗表示の仕上げ。

Kubo との bitswap は TCP 4001 で双方向を確認済み。WebSocket 経路は環境によって
TLS / SNI の制約があるため、TCP swarm を優先し、複数候補を順に試す。
接続に失敗した場合は 10 秒間隔で再試行する。Kubo 再起動直後などは、エラー表示のあと自動で復帰する。

## 既知の制限

- VRM は 0.x のみ。1.0 は読み込みに失敗し、簡易アバターのまま表示される。
- 自分の VRM は `V` の鏡で確認できる。鏡はワールドに固定された平面で、
  プレイヤーの移動には追従しない。反射はメインカメラを鏡面に対して反転した位置から描画する。
- VRM のアニメーション (歩行・待機) は未実装で、静的なポーズになる。
- XR・動画・URL 取り込みは未実装。
- 画像取得は埋め込み IPFS が失敗すると `/media/<cid>` にフォールバックする。
- ドラッグ&ドロップの複数ファイルは同じ位置に近接して置かれる。以前の Web 実装の横並びレイアウトと完全一致は未検証。
- 日本語入力は Bevy の `EditableText` / IME に依存する。Linux / Windows での実機確認が必要。
- ファイル名・URL の 3D ラベルは `Text2d` を使っており、カメラ構成によっては表示されない可能性がある。
- ダウンロードは OS のダウンロードディレクトリへ直接保存する。保存先ダイアログは未実装。
- AppImage は GPU ドライバ (Vulkan ICD) と X11 ライブラリをホストから使う。
  最小構成の Linux では追加パッケージが必要になる場合がある。
- 音声はまだ使っていないため、Bevy の AudioPlugin を無効化している。
- Windows ビルドは MinGW-w64 でクロスコンパイル済み。Wine で headless 入室と IPFS 起動を確認したが、
  実機の GPU / 音声 / IME / SteamVR は未検証。
