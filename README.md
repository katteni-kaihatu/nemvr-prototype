# prototype-alternative-resonite-1

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
最初のゴールは「複数ユーザーがアクセスできる 3D 空間」。

- スタック: TypeScript / Three.js (React Three Fiber) クライアント、Elixir/OTP (Cowboy) サーバー、Kubo (IPFS / libp2p / bitswap)
- ステータス: M5 実装済み (複数ユーザーが入室し、ファイルや画像をドラッグ&ドロップで 3D 空間に置ける。IPFS で共有し、つかんで動かす・複製・削除・ダウンロードができる)。バックエンドは Elixir/OTP に置き換え済み。

## 開発環境

必要なもの:

- [Nix](https://nixos.org/) (推奨): `nix develop` で Elixir / Kubo / Node 24 / pnpm が揃う
- または手動で: Elixir 1.14+ / OTP 25+、Node 24、pnpm、Kubo (`ipfs`)
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

### Kubo の準備 (初回のみ)

Kubo はサーバーとは別プロセスで動かす。API は 5001、ゲートウェイは 8082、libp2p の WebSocket は 8081 を使う。
`ipfs init` 済みの場合は `ipfs config` の 5 行だけでよい。

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

一方のターミナルで Kubo を起動し、もう一方でアプリを起動する。

```sh
# ターミナル 1
ipfs daemon

# ターミナル 2
pnpm dev   # Elixir サーバー (ws://localhost:8080, /media) と client (http://localhost:5173)
```

`pnpm dev` は `apps/server` の `mix run --no-halt` と `apps/client` の Vite を同時に起動する。
サーバーだけ / クライアントだけを動かす場合は `pnpm dev:server` / `pnpm dev:client`。

| ポート | 用途 |
|---|---|
| 5173 | クライアント (Vite) |
| 8080 | ワールド同期 (WebSocket) と `/media/<cid>` |
| 8081 | Kubo の libp2p WebSocket (ブラウザが接続する) |
| 8082 | Kubo ゲートウェイ (サーバーが `/media` のために使う。外部公開しない) |
| 5001 | Kubo API (localhost のみ) |

ブラウザで `http://localhost:5173` を複数タブで開き、名前を入力して入室する。
クリックで視点操作開始、WASD で移動、Shift で走る、Space でジャンプ (空中でもう一度押すと二段ジャンプ。物の上にも乗れる)、C または Ctrl (押している間) でしゃがみ、Q / E (押している間) で左右にリーン、Esc で解除。
ファイルを画面にドラッグ&ドロップすると、
ドロップ位置に置かれ、全員に表示される (視点操作中は Esc で解除してからドラッグする)。
画像 (PNG / JPEG / GIF / WebP, 5MB まで) は板として、それ以外の任意のファイル (1 個 2 GiB まで) は、ファイルの形のアイコンとして置かれる。
音声と映像は、種類が分かる専用のアイコンになる。アイコンには、ファイル名とサイズが表示される。
映像ファイルは、リングメニューの「再生」で、置いた場所のまま再生できる (板が映像の画面に広がる。全画面にはならない)。再生 / 一時停止と現在の位置は全員で同期し、途中から入った人も、いまの位置から再生する。全体の取得を待たず、**ブラウザ同士の P2P (IPFS)** で必要な範囲だけを受け取る (Service Worker 経由)。置いた人のブラウザが配り、いなければ Kubo など他のピアから取得する。アイコンには動画のサムネイル (1 コマ) が表示される。
置いたものは、画面中央の白い点で狙って操作できる (白い点は、視点や位置が動いている間と止まってから 3 秒間だけ表示される)。

| 操作 | 内容 |
|---|---|
| Shift を押しながら WASD | 走る (歩く速さの 2 倍。しゃがんでいる間は走れない) |
| 右ボタンを押し続ける | 狙っているもの (画像・ファイル・床のボックス) をつかんで運ぶ (離すと置く)。他の人がつかんでいる間は奪えない |
| つかんだ状態でホイール | つかんだものを視線に沿って遠ざける (上に回す) / 引き寄せる (下に回す)。水平距離 1〜30m |
| つかんだままマウスを上下に動かす | 視点の上下に合わせて、つかんだものが視線の先に付いたまま持ち上がる・下がる (移動モード。床〜20m) |
| つかんだ状態で E キー (つかんでいる間、E はリーンしない) | 移動モードと回転モードを切り替える。回転モードでは視点を固定し、マウスの左右で水平方向、上下で垂直方向に回す |
| 中ボタン | 狙っている (つかんでいる) ものの、リングメニューを開く。「再生 / 一時停止」(映像のみ)「削除」「複製」「ダウンロード」をマウスで選ぶ。外側のクリック・中ボタン・Esc で閉じる |

画像・ファイルは IPFS で共有される。ドロップしたものはブラウザ内の IPFS ノード (Helia) で CID になり、
サーバーは Kubo の HTTP API 経由で取得・検証・pin する。他のブラウザは CID から取得する
(WebRTC で直接つながればブラウザ同士、つながらなければ Kubo / サーバー経由)。HUD の `P2P n` は直接接続の数。
16MiB を超えるファイルは、置くとすぐにワールドに現れ、サーバーがバックグラウンドで全部を取得する (置いた人のタブが、取り終えるまで配る。2 GiB で約 1 分。それまで、置いた人はタブを開いたままにする)。
取り終える前に置いた人が退室したファイルは「オフライン」になり、取得できない。
ダウンロードは、先に繋がっている相手から直接取得を試し、だめならサーバーの取得の完了を待つ。どのピアからブロックが届いたかは、ダウンロード完了時の HUD に表示される。
動画の再生は、Service Worker でブラウザの IPFS のストリームを `<video>` に渡す (P2P)。サーバーの `/media/<cid>` は、Service Worker が使えない場合のフォールバックで、Kubo ゲートウェイから Range 単位で流す。
サーバーが Kubo に保持させる画像・ファイルは合計 20 GiB まで (環境変数 `CONTENT_MAX_TOTAL_MB`)。削除して誰も参照しなくなった分は unpin + GC で解放される。

### コンテンツの保存とサーバー再起動

画像・ファイルの実体は Kubo のリポジトリ (`/var/lib/proto/ipfs`、開発では `~/.ipfs`) に保存される。
サーバーは、オブジェクトが存在する間は CID を pin し、最後の参照が消えると unpin して GC する。
ワールドの状態 (配置・姿勢・動画の再生状態) はサーバーのメモリだけにあり、サーバーを再起動すると消える。
Kubo の pin / ブロックは残るため、再起動後に同じ CID を置き直せば再取得は不要。クラッシュなどで参照のない pin が残ることがあり、
その場合は `ipfs pin ls` で確認し、必要なら `ipfs repo gc` で整理する。

### `IPFS_PUBLIC_PORT` と `welcome.ipfs`

サーバーは入室時の `welcome.ipfs` に、Kubo の peer ID と `IPFS_PUBLIC_PORT` を載せる。
開発では `IPFS_PUBLIC_PORT` の既定は `IPFS_PORT` (8081)。本番は Caddy が TLS を終端する 8443 を指定する。
クライアントはこの値から libp2p の接続先を組み立てる。

### URL の貼り付け

`Ctrl+V` で http(s) の URL を貼ると、サーバーが取得して、ドロップしたときと同じように置きます (CORS の影響を受けません)。

- 画像: 画像として置く (PNG / JPEG / GIF / WebP、5MB まで。長辺 2.5m)。
- 動画・音声: ファイル (映像 / 音声のアイコン) として置く (128MB まで。動画はその場で再生できる)。
- それ以外 (HTML など): URL を書いたリンクのカードを置く (本文は取得しない)。カードを中ボタンで狙って、リングメニューの「ブラウザで開く」を選ぶと、ブラウザの別タブで開く。
- localhost・プライベート IP などの URL は、サーバーが拒否します。

### 鏡

北側 (z = -20) に 10m × 5m の鏡があります。鏡には自分のアバター (VRM、無ければ簡易アバター) が映ります (一人称のメイン視点には体を出しません)。
`M` キー、または HUD の「鏡: ON/OFF」ボタンで、反射を ON/OFF できます (このクライアントだけ。設定は保存されます)。
OFF のときは反射を止め、暗いガラスを表示します。

### アバター (VRM)

入室画面で任意の `.vrm` ファイル (64MB まで) を選ぶと、自分のアバターとして使える。ファイルはブラウザの IPFS に追加され、
他のユーザーは CID から取得して表示する (直接つながっていなくても、Kubo / サーバー経由で取得できる)。
サーバーは、そのユーザーが部屋にいる間だけアバターを Kubo に pin し、退室すると解放する。
指定しない場合や読み込めない場合は、これまでどおり簡易アバターになる。モデルのプレビューは無く、表情・ライセンスの扱いは未対応。
VRM は、待機中は呼吸と頭の微動、歩くと脚と腕を振る (手続き的なモーション。アニメーションのファイルは使わない)。
表示名とアバターは、このブラウザに保存され、次回の入室時に自動で入る (表示名は localStorage、VRM は IndexedDB)。「クリア」で保存したアバターを消せる。
退出したユーザーのアバターのデータは、他のクライアントから解放される (そのアバターを見ている人がいなくなったとき)。

### 別マシンのブラウザから使う場合

開発サーバーに別マシンから接続するには、ポート 5173 / 8080 / 8081 に到達できる必要がある。さらに、**IPFS は「安全なコンテキスト」でしか動かない**。
ブラウザ内の Helia / libp2p が Web Crypto (`crypto.subtle`) を使うためで、ブラウザはこれを HTTPS か `localhost` にしか提供しない。
そのため別マシンから `http://<サーバーの IP>:5173` で開くと、HUD に「IPFS: 接続失敗」と原因が表示され、画像を共有できない
(入室・移動・他の人の表示は動く)。次のいずれかで対処する。

- **localhost として開く (推奨)**: 別マシンから SSH のポート転送を張り、`http://localhost:5173` で開く。
  `ssh -L 5173:localhost:5173 -L 8080:localhost:8080 -L 8081:localhost:8081 <サーバー>`
- **開発用にそのオリジンを許可する**:
  - Firefox: `about:config` の `dom.securecontext.allowlist` に、サーバーのホスト (例: `192.168.16.174`) を追加する。
  - Chrome 系: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` に `http://<サーバーの IP>:5173` を追加して有効にする。
- **HTTPS / WSS で配信する**: 本番は Caddy が TLS を終端する (`docs/deploy.md`)。開発で HTTPS を使う場合は、ページ・ワールド同期・libp2p のすべてを TLS にする必要がある。

同じマシンの別タブ / 別ブラウザで `http://localhost:5173` を開く分には、そのまま使える。
なお Firefox はローカルのアドレスを mDNS で隠すため、同じマシン上のブラウザ同士では WebRTC が通らず `P2P 0` のままになることがある
(画像は Kubo / サーバー経由で共有される)。

別ホストの server に繋ぐ場合は `VITE_WS_URL=ws://host:8080` を指定する。

### 型チェック・テスト・smoke test

```sh
pnpm typecheck   # 型チェック (Elixir は mix compile --warnings-as-errors)
pnpm test        # 単体テスト (client: Vitest / server: ExUnit)
pnpm smoke:ws    # サーバー (localhost:8080) を起動した状態で実行
```

`pnpm smoke:ws` はサーバーを起動した状態で実行する。既定は `ws://127.0.0.1:8080/anything` と
`http://127.0.0.1:8080`。別のポートやホストを使う場合は `WS_URL` / `HTTP_URL` で上書きする
(例: `WS_URL=ws://127.0.0.1:18080/anything HTTP_URL=http://127.0.0.1:18080 pnpm smoke:ws`)。
`pnpm` のスクリプトが未定義の環境では `node scripts/smoke-ws.mjs` を同じ環境変数で実行する。

## CRDT について

クライアントには休止中の CRDT コード (`packages/world-sync`) が残っているが、Elixir/OTP サーバーは `crdt-v1` を実装していない。
`VITE_SYNC_MODE=crdt-v1` を指定すると、クライアントはサーバーが対応していない旨のエラーを表示する。
過去の設計と障害試験は [CRDT 実験モード (歴史的設計)](docs/crdt-experiment.md) を参照。

## ドキュメント

- [アーキテクチャ](docs/architecture.md) - スコープ、全体構成、技術選定、設計判断
- [詳細設計](docs/design.md) - プロトコル、同期方式、クライアント / サーバー内部設計
- [Elixir/OTP バックエンド契約](docs/otp-backend.md) - サーバーのインターフェース、モジュール、制限
- [CRDT 実験モード (歴史的設計)](docs/crdt-experiment.md) - 停止耐性の設計、設定、障害試験 (サーバーでは未対応)
- [マイルストーン](docs/milestones.md) - 段階的な進め方
- [デプロイ (VPS)](docs/deploy.md) - Caddy + Kubo + proto-server + coturn の構成、手順、注意点
