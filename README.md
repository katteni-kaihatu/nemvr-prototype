# prototype-alternative-resonite-1

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
最初のゴールは「複数ユーザーがアクセスできる 3D 空間」。

- クライアント: Rust / Bevy のネイティブアプリ (`apps/client`)
- サーバー: Elixir/OTP (Cowboy)
- コンテンツ: Kubo (IPFS / libp2p / bitswap)
- 同期: space v2 (n次元エンティティストア / Reader / Writer)
- 配布: Linux AppImage / Windows zip

Web クライアントは削除済み。旧実装は Git の `web-client-final` タグに残している。

## ネイティブクライアント

実装済み: 入室、移動・しゃがみ・リーン・ジャンプ、姿勢同期と補間、簡易アバター、
画像・ファイル・ボックス・リンクの表示、ドラッグ&ドロップ配置、
つかむ・移動・回転・拡大縮小・削除・複製・ダウンロード、日本語 UI、IPFS 共有。

未実装: VRM、OpenXR / PC VR、動画、URL 取り込み、鏡。
Windows はクロスビルドと Wine での headless 確認まで。実機 GPU / IME / SteamVR は未検証。

```sh
nix develop
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
rustup run 1.95.0 cargo run -p proto-client -- --server ws://127.0.0.1:8080/ws
```

操作・設定・制限の詳細は [`docs/bevy-client.md`](docs/bevy-client.md) を参照。

### 接続先

| 環境 | Lobby の「サーバー」欄 |
|---|---|
| ローカル | `ws://127.0.0.1:8080/ws` |
| 開発 VPS | `wss://nemvr.nemnomi.dev/ws` |

`wss://` と末尾の `/ws` まで含めて入力する。`--name` を付けると Lobby を飛ばせる。
VPS のランディングページ (`https://nemvr.nemnomi.dev/`) から配布物をダウンロードできる。

## パッケージ

```sh
nix develop
bash scripts/package-linux.sh     # dist/ProtoSNS-x86_64.AppImage

nix develop .#windows
bash scripts/package-windows.sh   # dist/ProtoSNS-windows-x86_64.zip
```

既存のバイナリを使う場合は `--no-build` を付ける。
同梱ライブラリ、Wayland / NixOS での実行、Wine での確認、制限は
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
E で移動 / 回転モード、中クリックまたは M でリングメニュー、B でボックス配置。
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
pnpm e2e:client  # 2 つのネイティブ headless クライアントで入室・配置
```

Rust:

```sh
pnpm test:native
pnpm clippy:native
pnpm fmt:native
```

`pnpm e2e:client` は先に `pnpm build:native` で `target/release/proto-client` を作る。
`WS_URL=wss://nemvr.nemnomi.dev/ws pnpm e2e:client` で VPS に対しても実行できる。

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

- [ネイティブクライアント](docs/bevy-client.md)
- [パッケージ](docs/packaging.md)
- [アーキテクチャ](docs/architecture.md)
- [詳細設計](docs/design.md)
- [OTP サーバー](docs/otp-backend.md)
- [デプロイ (開発 VPS)](docs/deploy.md)
- [マイルストーン](docs/milestones.md)
- [n次元クライアント構想](docs/n-dim-client-original.md)
- [UGC ランタイム構想](docs/ugc-runtime.md)
- [CRDT 実験 (歴史的設計)](docs/crdt-experiment.md)
