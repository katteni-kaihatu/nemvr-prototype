# Godot クライアント (既定)

`apps/godot-client` は、既存の space v2 / Kubo / rust-ipfs 構成に接続する
Godot 4.6.3 クライアント。Linux では Bevy クライアント (`apps/client`) から
既定を置き換えている。

2026-10-23 時点では Linux の実シーン検証まで完了している。Windows はパッケージと
Wine headless 起動まで確認済みだが実機 GPU / IME / ドロップが未検証のため、
Windows の `package:windows` は Bevy のままにしている。Bevy は比較用に残す。

## 責務の境界

- 共有世界の正本は Elixir の `Space.Store`。Godot のシーンツリーや `Node` は正本ではない。
- 接続ごとの `Space.Reader` / `Space.Writer` と、BEAM 上のスコープ検証・状態確定は維持する。
- Godot は `vr-sns-3d@1` の表示・入力シェル。`entity.kind` と次元を表示 Node へ写像する。
- Godot MultiplayerAPI やシーンツリー同期は使わない。未知の次元は破棄せず保持し、
  表示できない種類だけをシーンに出さない。
- 同期・IPFS・移動計算は `crates/client-core` にあり、Bevy / Godot のどちらからも使う。
  Godot からは薄い GDExtension (`crates/godot-client`, package `proto-godot`) を経由する。
- UGC の GDScript / `.tscn` / `.tres` / PCK を取得して実行する機能はない。将来の UGC は
  `docs/n-dim-client-original.md` の WASM 実行基盤とプログラム別 Reader / Writer による。

```text
Godot scenes / scripts
  -> ProtoClient GDExtension
  -> client-core (ClientSession, SpaceStore, WS, IPFS, movement, collision)
  -> BEAM Reader / Writer -> Space.Store
```

## 起動

```sh
nix develop
pnpm dev:client             # Linux の既定 (dev:godot と同じ)

# Lobby を飛ばす
pnpm dev:client -- --server ws://127.0.0.1:8080/ws --name alice

# VRM / 鏡 / スクリーンショット
pnpm dev:client -- --server ws://127.0.0.1:8080/ws --name alice \
  --avatar ~/avatar.vrm --mirror --screenshot /tmp/proto.png
```

`--data-dir` を指定すると設定・キャッシュ・IPFS repo を分離できる。指定しない場合は
Bevy クライアントと同じ `directories` の保存先を使う。

操作は Bevy クライアントと同じ。WASD / 矢印、Shift、Space (二段ジャンプ)、C / Ctrl、
Q / E、右クリックでつかむ、ホイール、Shift+ホイール、E で回転モード、中クリック / M、
B、V、Esc、ファイルドロップ。

## デバッグ

HUD 右上には FPS とフレーム時間を常時表示する。

- `F3`: FPS・座標・エンティティ数・carry 中の ID を表示するオーバーレイ
- `F12`: `user://screenshots/YYYY-MM-DD_HH-MM-SS.png` にスクリーンショットを保存
- `--position x,y,z`: 入室時の足元位置を指定する
- `--yaw <度>` / `--pitch <度>`: 入室時の視線を指定する
- `--hide-hud`: HUD を隠して撮影する
- `--no-floor-reflection`: 床の平面反射を無効にする (低スペック環境向け)
- `--quality high|medium|low`: 画質プリセットを一時的に指定する (Lobby の選択より優先)
- `--benchmark <秒>`: 指定秒数の FPS を計測し、`benchmark` イベントを出して終了する
- `--scenario walk`: 前後に歩いて歩行アニメーションと姿勢同期を確認する
- `PROTO_KUBO_WSS_ONLY=1`: TCP 4001 を試さず、Kubo の `/tls/ws` だけで接続する
- `--screenshot <path>` / `--screenshot-delay <秒>`: 自動撮影

```sh
pnpm dev:client -- --server wss://nemvr.nemnomi.dev/ws --name visual \
  --position 0,0,5 --pitch -6 --hide-hud \
  --screenshot /tmp/proto.png --screenshot-delay 2.5 --duration 8
```

## 描画

`world.tscn` は Forward+ 向けに次を使う。

- 星空・地平線グロー・太陽を含むカスタム sky shader
- ワールド座標のマイナー / メジャーグリッド、距離フェード、発光を持つ床 shader
- 面の向き・リム・スキャンライン・エッジ発光を持つエンティティ shader
- 床の平面反射 (ミラーカメラの専用ビューポート)、SSAO、グロー、フォグ、ACES トーンマップ、暗い周辺減光 (vignette)

Lobby の「画質 / Quality」で High / Medium / Low を選べる。設定は
`user://settings.cfg` に保存される。

| Quality | 床反射 | 3D スケール | SSAO / グロー / フォグ | 影距離 |
|---|---|---|---:|---:|
| High | フル解像度 | 1.0 | 有効 | 72 m |
| Medium | 0.6 倍 | 0.85 | 有効 | 48 m |
| Low | 無効 | 0.7 | 無効 | 28 m |

測定結果と再計測方法は [`performance.md`](performance.md) を参照。

シェーダは `apps/godot-client/shaders/` にあり、床・エンティティ・空・vignette を
シーンから差し替えられる。

## ビルドと検証

```sh
pnpm build:godot            # native + import
pnpm test:godot             # native bridge / presentation / avatar runtime
pnpm test:godot:mirror      # 実描画の鏡ピクセル検証
pnpm e2e:godot              # 2 クライアントの実シーン E2E
pnpm e2e:godot:mixed        # Bevy placer -> Godot observer の混在 E2E
```

`test:godot` と `e2e:godot` は実際の GDExtension とプロジェクトシーンを使う。
`e2e:godot:mixed` は `pnpm build:native` で作った `target/release/proto-client` を使い、
Bevy が作成したエンティティを Godot 側の実 Node と位置で確認する。
E2E は観測側で、同じエンティティ ID の Node が作成・移動・削除されたことを確認する。

画像・複数ブロックのファイル・VRM の IPFS 共有は、Kubo とサーバーを起動した上で
次を実行する。2 つの独立した IPFS repo を使い、観測側の実 Node と SHA-256 を確認する。

```sh
/path/to/godot --headless --path apps/godot-client \
  --script res://tests/content_roundtrip.gd -- \
  --server=ws://127.0.0.1:8080/ws --avatar=/path/to/avatar.vrm
```

`test:godot:mirror` はグラフィカルセッションが必要で、Forward+ と GL Compatibility の
両方で鏡のピクセルを検証する。headless では成功扱いにならない。
パッケージ既定は Forward+ / Vulkan。GL Compatibility は Vulkan が使えない環境向けの
フォールバックとして `--rendering-method gl_compatibility` で指定できるが、ホストの
OpenGL / EGL に依存する。

## VRM と鏡

- VRM 0.x の humanoid を使い、idle / walk / crouch をプロシージャルに動かす。
  hand / finger、spring bone、animation clip、retargeting、VRM 1.0 は対象外。
- humanoid の `humanBones` は 0.x の配列形式と辞書形式の両方を受け付ける。
  肩・腕・脚・膝・足・頭のボーンを glTF ノード名から対応付ける。
- humanoid 以外の tail / hair / skirt ボーンには、速度と時間に応じた二次揺れを加える。
- 取得した CID のファイルは、同梱した信頼済みローダーが実行時に読み込む。
  ダウンロードしたファイルを `ResourceLoader` でスクリプト・シーンとして実行しない。
- GLB のサイズ、埋め込みリソース、ノード数、メッシュ・画像の上限を検証し、
  外部 URI や未知の拡張、sparse accessor を拒否する。失敗時は簡易アバターへ戻す。
- 自分の VRM は固定平面の鏡にだけ表示する。反射カメラは自分のレイヤーを含み、
  鏡自身のレイヤーを含めないため再帰しない。

## 画像

CID キャッシュには拡張子がないため、表示側でパス拡張子に依存しない。Rust の
`decode_image` が PNG / JPEG / GIF / WebP を先頭バイトから判定し、サイズと
ピクセル数の上限を検査して RGBA を返す。GIF は先頭フレームを表示する。

## 配布

```sh
pnpm package:godot:linux     # dist/ProtoSNS-godot-x86_64.AppImage (+ tar.gz)
pnpm smoke:godot:linux       # AppImage の headless + 実描画起動
nix develop .#windows
pnpm package:godot:windows   # dist/ProtoSNS-godot-windows-x86_64.zip
pnpm smoke:godot:windows     # Wine で headless 起動 (GDExtension / PCK)
```

Nix の固定版 Godot と同名の export templates を使う。Linux は AppImage とポータブル
tar.gz、Windows は zip を生成する。成果物には Godot の実行ファイル、PCK、
`libproto_godot.so` / `proto_godot.dll`、VRM/MToon/フォントのライセンスを含む。
Linux AppImage はホストの glibc と loader を使い、X11・Wayland・Vulkan ローダ・
xkb データを同梱する。`APPIMAGE_EXTRACT_AND_RUN=1` でも起動できる。

## Bevy 比較用クライアント

`apps/client` (Bevy) は Godot との比較用に当面残す。Windows の `package:windows` は Bevy のまま。
移行開始時点の最終 Bevy コミットは `4c9a009` で、次のコマンドで従来構成に戻せる。

```sh
pnpm dev:bevy
pnpm package:bevy:linux
pnpm package:windows
```

Bevy の参照コミットは `4c9a009`。Godot を既定に切り替えた後も、このコミットから
Bevy クライアントを復元できる。

## 既知の制限

- Windows 実機の GPU / IME / ファイルドロップ、日本語入力の実操作は未検証。
  Windows パッケージの Wine headless 起動 (GDExtension / PCK の読み込み) は
  `pnpm smoke:godot:windows` で確認できる。
- VRM は 0.x のみ。指・spring bone・animation clip・VRM 1.0・三人称は未対応。
- Web エクスポート、OpenXR、動画、URL 取り込み、WASM UGC、ユーザー定義写像は未実装。
- 音声は未使用。キャッシュの上限・eviction は Bevy と同様に未完成。
- Linux の既定は Godot。Windows の通常配布は実機確認が終わるまで Bevy のまま。
