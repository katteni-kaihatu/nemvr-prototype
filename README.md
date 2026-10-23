# prototype-alternative-resonite-1

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
最初のゴールは「複数ユーザーがアクセスできる 3D 空間」。

- クライアント: Godot 4.6 のネイティブアプリ (`apps/godot-client`)。Bevy 版は退避経路 (`apps/client`)
- サーバー: Elixir/OTP (Cowboy)
- コンテンツ: Kubo (IPFS / libp2p / bitswap)
- 同期: space v2 (n次元エンティティストア / Reader / Writer)
- 配布: Linux AppImage / Windows zip

Web クライアントは削除済み。旧実装は Git の `web-client-final` タグに残している。

## Godot クライアント (既定)

`apps/godot-client` は space v2 / Kubo に接続する Godot 4.6.3 実装。シーン・UI・入力は
GDScript、同期・IPFS・移動計算は Bevy 非依存の `crates/client-core` を GDExtension 経由で
再利用する。世界の正本は Godot のシーンツリーではなく、従来どおり BEAM 上の
`Space.Store` / `Reader` / `Writer` である。

実装済み: 入室、移動・しゃがみ・リーン・ジャンプ、姿勢同期と補間、簡易アバター、
画像・ファイル・ボックス・リンクの表示、ドラッグ&ドロップ配置、
つかむ・移動・回転・拡大縮小・削除・複製・ダウンロード、日本語 UI、IPFS 共有、
VRM 0.x アバター (`.vrm` のドロップ / `--avatar`)、自分のアバターを見る鏡 (`V`)。

未実装: VRM のアニメーション・1.0、OpenXR / PC VR、動画、URL 取り込み。

```sh
nix develop
pnpm dev:client -- --server ws://127.0.0.1:8080/ws --name alice
pnpm test:godot
pnpm e2e:godot
pnpm e2e:godot:mixed   # Bevy が置いたオブジェクトを Godot が実 Node として表示
```

Linux では入室・移動・オブジェクト操作・画像/複数ブロックファイル/VRM の IPFS 共有・鏡の
実描画まで検証済み。描画は星空の sky shader、発光グリッド床、平面反射 / SSAO / グローを使う。
Lobby の画質選択で High / Medium / Low を切り替えられる。`F3` でデバッグ表示、`F12` でスクリーンショット。Windows は配布物と Wine headless 起動まで
確認済みで、実機 GPU / IME / ファイルドロップ / SteamVR は未検証。Windows の通常配布は
実機確認まで Bevy のままにしている。操作・設定・制限の詳細は
[`docs/godot-client.md`](docs/godot-client.md) を参照。

## Bevy クライアント (退避経路)

`apps/client` の Bevy 実装は退避経路として残している。`dev:client` / `package:linux` は
Godot に切り替え済みで、Bevy を使う場合は明示的なコマンドを指定する。
Windows の実機確認が終わるまで `package:windows` は Bevy をビルドする。

```sh
pnpm dev:bevy -- --server ws://127.0.0.1:8080/ws --name alice
pnpm package:bevy:linux
pnpm package:bevy:windows

# 直接実行する場合
rustup run 1.95.0 cargo run -p proto-client -- --server ws://127.0.0.1:8080/ws
```

**Windows 実機の GPU / IME / SteamVR は未検証。** Godot 版の Windows 候補は
`pnpm package:godot:windows` で作成する。操作・設定・制限の詳細は
[`docs/bevy-client.md`](docs/bevy-client.md) を参照。

### 接続先

| 環境 | Lobby の「サーバー」欄 |
|---|---|
| ローカル | `ws://127.0.0.1:8080/ws` |
| 開発 VPS | `wss://nemvr.nemnomi.dev/ws` |

`wss://` と末尾の `/ws` まで含めて入力する。`--name` を付けると Lobby を飛ばせる。
VPS のランディングページ (`https://nemvr.nemnomi.dev/`) から配布物をダウンロードできる。

## パッケージ

Linux の既定は Godot 版。

```sh
nix develop
pnpm package:linux          # dist/ProtoSNS-godot-x86_64.AppImage / tar.gz
pnpm smoke:godot:linux      # AppImage の headless + 実描画起動
```

Windows は実機確認が終わるまで Bevy 版を既定にしている。

```sh
nix develop .#windows
pnpm package:windows        # dist/ProtoSNS-windows-x86_64.zip (Bevy)
```

Godot 版の Windows 候補は次のコマンドで作る。

```sh
nix develop .#windows
pnpm package:godot:windows  # dist/ProtoSNS-godot-windows-x86_64.zip
pnpm smoke:godot:windows    # Wine で headless 起動
```

Bevy 版の Linux パッケージは `pnpm package:bevy:linux`。既存のバイナリを使う場合は
`--no-build` を付ける。同梱ライブラリ、Wayland / NixOS での実行、Wine での確認、制限は
[`docs/packaging.md`](docs/packaging.md) を参照。

## 開発環境

**このプロジェクトの VPS (`nemvr.nemnomi.dev` / `root@172.104.89.28`) は開発・検証環境であり、本番環境ではない。**
ワールド状態はメモリのみで、デプロイや再起動で消える。認証・可用性・バックアップは対象外。

必要なもの:

- [Nix](https://nixos.org/) (推奨): `nix develop` で Elixir / Kubo / Node / pnpm / Rust が揃う
- または手動で: Elixir 1.14+ / OTP 25+、Node 24、pnpm、Kubo (`ipfs`)、Rust 1.95+
- 初回だけ `mix deps.get` と Hex / rebar の取得が必要

```sh
nix develop
cd apps/server
mix local.hex --force
mix local.rebar --force
mix deps.get
cd ../..
pnpm install
```

### Kubo

Kubo はサーバーとは別プロセスで動かす。API は 5001、ゲートウェイは 8082、
libp2p は 4001 と WebSocket 8081 を使う。

```sh
ipfs init --profile=server
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8082
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001","/ip4/0.0.0.0/tcp/8081/ws"]'
ipfs config --json Swarm.RelayService.Enabled true
ipfs config --json Swarm.RelayClient.Enabled true
```

Kubo の API (5001) は localhost だけで待ち受ける。外部に公開しないこと。

### 起動

```sh
# ターミナル 1
ipfs daemon

# ターミナル 2
pnpm dev          # Elixir サーバー (ws://localhost:8080, /media)

# ターミナル 3
pnpm dev:client   # Bevy クライアント
```

| ポート | 用途 |
|---|---|
| 8080 | ワールド同期 (WebSocket) と `/media/<cid>` |
| 8081 | Kubo の libp2p WebSocket |
| 8082 | Kubo ゲートウェイ (サーバーが `/media` のために使う。外部公開しない) |
| 4001 | Kubo の libp2p swarm (ネイティブクライアントが接続) |
| 5001 | Kubo API (localhost のみ) |

### 操作

左クリックで視点操作開始、WASD で移動、Shift で走る、Space でジャンプ
(空中でもう一度押すと二段ジャンプ)、C / Ctrl でしゃがみ、Q / E でリーン。
右クリックでつかむ / 離す、ホイールで距離、Shift+ホイールで拡大縮小、
E で移動 / 回転モード、中クリックまたは M でリングメニュー、B でボックス配置、V で鏡。
ファイルをドラッグ&ドロップすると視線先の床に置かれる。
Esc でポインタロック解除。

画像・ファイルは Kubo とネイティブ IPFS ノードの bitswap で共有する。
取得に失敗した場合は `/media/<cid>` にフォールバックする。
Kubo の swarm 4001 が使えない場合に備え、接続先は複数候補を順に試す。

### テスト

```sh
pnpm typecheck   # Elixir は mix compile --warnings-as-errors、protocol は tsc
pnpm test        # ExUnit + protocol のテスト
pnpm smoke:ws    # サーバーを起動した状態で実行
pnpm stress:ws   # 20 クライアントの同期ストレステスト
pnpm e2e:client      # Godot 2 クライアントで入室・作成・移動・削除
pnpm e2e:godot:mixed # Bevy placer -> Godot observer (先に pnpm build:native)
pnpm e2e:mirror      # Godot の鏡を実描画で確認
pnpm e2e:bevy        # Bevy 2 クライアントの入室・配置
```

Rust:

```sh
pnpm test:native
pnpm clippy:native
pnpm fmt:native
```

`pnpm e2e:client` は Godot 側の拡張をビルドしてから実行する。
`WS_URL=wss://nemvr.nemnomi.dev/ws pnpm e2e:godot` で VPS に対しても実行できる。
Bevy 版の E2E は `pnpm e2e:bevy` で、先に `pnpm build:native` が必要。

### デプロイ

```sh
nix develop -c bash -lc \
  'DEPLOY_HOST=root@172.104.89.28 SSH_KEY=$HOME/.ssh/linode.com deploy/deploy.sh'
```

`deploy/deploy.sh` は VPS 上で Elixir release をビルドし、サーバーを再起動する。
`dist/` に配布物があれば、ランディングページの `downloads/` に転送する。
Caddy が TLS を終端し、`wss://<host>/ws` をサーバーへ転送する。
手順・ロールバック・構成は [`docs/deploy.md`](docs/deploy.md) を参照。

## space v2 と n次元エンティティ

ワールドは `space v2` プロトコルで同期する。サーバーはセッションごとに 1 つの
`ProtoServer.Space.Store` を持ち、エンティティを「名前付き次元の値のマップ」として保存する。
クライアントは `Space.Reader` で購読し、`Space.Writer` で操作する。
3D 表示は `vr-sns-3d@1` の写像テンプレートが担当する。

次元・スコープ・プロトコルの詳細は [詳細設計](docs/design.md) と
[n次元クライアント構想](docs/n-dim-client-original.md) を参照。
WASM UGC、ユーザー定義の写像関数、空間の動的分割、リードレプリカ、永続化、
アカウント認証は未実装。ケーパビリティは構造上の制約であり、悪意あるクライアントに対する
認証境界ではない。

## ドキュメント

- [Godot クライアント (既定)](docs/godot-client.md)
- [性能測定](docs/performance.md)
- [Bevy クライアント (退避経路)](docs/bevy-client.md)
- [パッケージ](docs/packaging.md)
- [アーキテクチャ](docs/architecture.md)
- [詳細設計](docs/design.md)
- [OTP サーバー](docs/otp-backend.md)
- [デプロイ (開発 VPS)](docs/deploy.md)
- [マイルストーン](docs/milestones.md)
- [n次元クライアント構想](docs/n-dim-client-original.md)
- [UGC ランタイム構想](docs/ugc-runtime.md)
- [CRDT 実験 (歴史的設計)](docs/crdt-experiment.md)
