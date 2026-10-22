# アーキテクチャ

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
**最初のゴールは「複数ユーザーが同時にアクセスできる 3D 空間」** であり、それ以外は意図的にスコープ外とする。

## 0. 現在の実装: space v2 (n次元エンティティ基盤)

現行サーバーは `docs/n-dim-client-original.md` の基盤部分を実装している。

- ワールドは「名前付き次元の値を持つエンティティ」の集合。`entity.kind`、`space.*`、`time.*`、`session.id`、`interaction.*`、`content.*`、`peer.*` などの次元を持つ。
- セッションごとに `ProtoServer.Space.Store` が 1 プロセス。状態はメモリに置き、`version` で変更を識別する。
- 接続ごとに `ProtoServer.Space.Reader` と `ProtoServer.Space.Writer` が 1 プロセスずつ動く。
  - Reader は購読フィルタに合うスナップショットと差分だけを受け取る。
  - Writer はケーパビリティ（読める次元・書ける次元・値域・対象セッション）を検証してから Store に書き込む。
- クライアントは Reader / Writer のシェルで、3D 表示は組み込みの写像テンプレート `vr-sns-3d@1` が担当する。
- プロトコルは `space_join` / `space_query` / `space_subscribe` / `space_mutate` / `space_import_url` / `space_set_avatar` / `file_request` の v2 のみ。旧 `join` / `pose` / `object_*` / `place_*` / `sync_*` は廃止。
- 1 セッション (`main`)・メモリ保持・1 Store。動的分割、リードレプリカ、永続化、WASM UGC、ユーザー定義写像、認証は未実装。

以下の 1〜9 節は、v2 の 3D テンプレートが満たすべき表示・コンテンツ・IPFS の設計と、そこに至る経緯を残したものである。プロトコルとデータモデルの正本は `docs/design.md` の「space v2」節とする。

## 1. 方針

- **簡素さ最優先**。プロトタイプなので、認証・永続化・スケールアウト・最適化は行わない。
- **ブラウザだけで動く** (Three.js / React Three Fiber)。WebXR は後続フェーズで追加する。
- **サーバーは薄いリレー**。ワールドの状態は「接続中ユーザーの姿勢」と「置かれたオブジェクト」だけをメモリに持つ。
- **IPFS は外部の Kubo に委譲する**。サーバーは Kubo の HTTP API / ゲートウェイを使い、libp2p / bitswap / pin / blockstore は持たない。
- クライアント / サーバー間で **型を共有** し、プロトコルの不整合を防ぐ。
- サーバーは **Elixir/OTP (Cowboy)** の GenServer 群で構成する。

## 2. スコープ

### 今回の対象 (M0〜M5)

| 項目 | 内容 |
|---|---|
| 3D 空間 | 床・簡単なオブジェクトがあるだけの 1 ワールド |
| 入室 | 表示名を入力して入室 (認証なし) |
| 移動 | デスクトップ操作 (WASD + マウス視点) |
| アバター | 色付きの簡易アバター (胴体 + 頭) + 名前表示。VRM は任意 |
| 同期 | 全ユーザーの位置・向きをリアルタイム表示 |
| 画像の配置 | 画像ファイルをドラッグ&ドロップして 3D 空間に置く。画像本体は IPFS (CID) で共有し、全員に同期される |
| ファイルの配置 | 任意のファイルをドロップして、ファイルの形のアイコンとして 3D 空間に置く (音声・映像は専用のアイコン)。コンテキストメニューからダウンロードできる |
| オブジェクト操作 | 画面中央のカーソルで画像を狙い、右ボタンでつかんで動かす (全員に同期。つかんでいる間は排他)。中ボタンのリングメニューから削除・複製 |

### 対象外 (後続)

WebXR / VR コントローラ、ボイスチャット、ファイルのプレビュー、画像以外のワールド内編集
(画像の回転・拡大縮小、元に戻す、操作の権限管理を含む)、ユーザーアカウント、永続化、複数ルーム、物理演算、チャット。

## 3. 全体構成

```mermaid
graph LR
    subgraph Browser A
        CA[client<br/>Vite + R3F + Helia]
    end
    subgraph Browser B
        CB[client<br/>Vite + R3F + Helia]
    end
    subgraph Server
        S["proto-server<br/>Elixir/OTP (Cowboy)<br/>Space.Store / Reader / Writer / Content / Queue / Place / Ipfs"]
    end
    subgraph IPFS
        K["Kubo<br/>API 5001 / Gateway 8082<br/>libp2p ws 8081 / bitswap / pin"]
    end

    CA <-->|WebSocket / JSON<br/>姿勢・配置・ピア ID| S
    CB <-->|WebSocket / JSON| S
    S -->|"Kubo HTTP API"| K
    S -->|"Gateway (Range)"| K
    CA <-->|"libp2p WebSocket<br/>bitswap"| K
    CB <-->|"libp2p WebSocket<br/>bitswap"| K
    CA <-.->|WebRTC (直接)<br/>bitswap| CB
```

- クライアントは自分の姿勢を一定間隔でサーバーに送る。
- サーバーは全員の姿勢をまとめて (スナップショット) 一定間隔で全員に配信する。
- クライアントは受信した他人の姿勢を補間して描画する。自分自身はローカルで即時反映する。
- 画像・ファイルは Kubo が持つ IPFS ノードで共有する。ワールドの同期 (WebSocket) には CID だけを載せ、
  本体は libp2p の bitswap で取得する。取得元は Kubo (常時接続・pin 済み) と、直接つながった他のブラウザ (WebRTC)。
- サーバーは Kubo の peer ID を `space_welcome.ipfs` でクライアントに伝える。クライアントは `IPFS_PUBLIC_PORT`
  (開発 8081 / 開発 VPS 8443) と組み合わせて接続先を組み立てる。

## 4. 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| 言語 (client) | TypeScript | 共有型と UI / 3D を同じ言語で扱う |
| 言語 (server) | Elixir / OTP | 軽量プロセスと supervision で、接続ごとの状態と障害分離を素直に書ける |
| パッケージ管理 | pnpm workspace | 共有パッケージを簡単に扱える |
| クライアント | Vite + React + three + @react-three/fiber + @react-three/drei | 宣言的な 3D、開発サイクルが速い |
| XR (後続) | @react-three/xr | WebXR のラッパー |
| サーバー | Elixir/OTP + Cowboy | HTTP と WebSocket を 1 リスナーで扱う。GenServer で Space.Store / Content などを分離 |
| メッセージ形式 | JSON | デバッグ容易。必要になったらバイナリ化 |
| 画像の共有 | IPFS (Kubo + ブラウザの Helia + libp2p) | 内容アドレス (CID) で扱い、ブラウザ同士 (WebRTC) でも配れる |
| サーバーの IPFS 境界 | Kubo HTTP API + Gateway | サーバーの再起動で blockstore / pin / peer ID を失わない。API は localhost に閉じる |

> Node / pnpm のバージョンは実装着手時に確認して `package.json` の `engines` に記載する。

## 5. リポジトリ構成

```
.
├─ package.json
├─ pnpm-workspace.yaml
├─ flake.nix            # Elixir / Kubo / Node / pnpm の開発シェル
├─ scripts/
│  └─ smoke-ws.mjs      # Kubo なしでも動く WS / media の smoke test
├─ docs/
│  ├─ architecture.md   # このファイル
│  ├─ design.md         # プロトコル・同期・シーンの詳細設計
│  ├─ otp-backend.md    # Elixir/OTP サーバーのインターフェース契約
│  ├─ crdt-experiment.md # crdt-v1 の歴史的設計 (サーバーでは未対応)
│  └─ milestones.md     # 段階的な進め方
├─ packages/
│  ├─ protocol/         # 共有メッセージ型・space スキーマ (実行時依存なし)
│  └─ world-sync/       # (削除済み) 旧 CRDT 実験
├─ apps/
│  ├─ server/           # Elixir/OTP サーバー (mix.exs / lib / test / config)
│  └─ client/           # Vite + R3F クライアント
└─ deploy/              # VPS 構築・デプロイスクリプト
```

## 6. コンポーネント責務

### server (`apps/server`)

- Cowboy の 1 リスナーで HTTP と WebSocket を受け付ける (`PORT` / `HOST`)。
  `/media/...` は HTTP、それ以外は WebSocket アップグレード。
- `space_join` を受けたら peer エンティティを作り、接続ごとに `Space.Reader` と `Space.Writer` を起動する。
- `Space.Store` はセッションごとのエンティティ、version、購読、フィルタ、上限を保持する。
- `Space.Reader` は購読フィルタに合うスナップショットと差分を 20Hz で返す。`Space.Writer` はスコープ・スキーマ・条件を検証して Store に書き込む。
- `Place` は画像・ファイル・URL・アバターの取得と検証を行い、成功時に Store にエンティティを作る。
- `Content` / `Queue` / `Ipfs` / `Turn` / `UrlFetch` / `Media` / `Protocol` は従来の責務を維持する。
- 旧 `join` / `pose` / `object_*` / `place_*` / `sync_*` は受け付けず、`space_error`（`protocol_mismatch`）を返す。

### client (`apps/client`)

- 入室画面 (名前入力) → 3D シーン。
- `SpaceReader` でエンティティを購読し、`SpaceWriter` で操作を送る。
- `vr-sns-3d@1` 写像が `space.*` / `content.*` / `peer.*` を既存の `WorldObject` / `PeerState` に変換する。
- ローカルプレイヤーの入力処理と移動 (クライアント権威)。姿勢は自分の peer エンティティへの patch として 20Hz で送る。
- ブラウザ内で Helia ノードを動かし、Kubo (と他のブラウザ) に接続する。
- 画像・ファイルのドロップ、つかむ・移動・複製・削除、動画再生、URL 取り込みを Writer 経由で行う。

### Kubo

- libp2p ノード、blockstore、pin、bitswap、circuit relay を持つ。
- API は `127.0.0.1:5001`、ゲートウェイは `127.0.0.1:8082`、libp2p は `0.0.0.0:4001` と `0.0.0.0:8081/ws`。
- ブラウザは Caddy の `:8443` 経由で libp2p WebSocket に接続する。
- API は絶対に外部公開しない。

### protocol (`packages/protocol`)

- client / server 間のメッセージ型と定数 (送信間隔など) を定義する。

## 7. 設計上の判断

| 判断 | 内容 | 理由 / トレードオフ |
|---|---|---|
| サーバーを Elixir/OTP にする | Space.Store / Reader / Writer / Content / Queue / Place / Ipfs を GenServer に分ける | 接続・取得・配置の状態をプロセスごとに閉じ込め、障害の影響を局所化できる |
| IPFS を Kubo に委譲する | サーバーは HTTP API とゲートウェイだけを使う | libp2p / bitswap / pin / blockstore の実装を持たずに済む。サーバー再起動でブロックを失わない |
| クライアント権威の移動 | 自分の位置はクライアントが決めて送信 | 実装が簡単。チートは許容 (プロトタイプ) |
| 購読はフィルタ + 差分 | Reader が部分空間のスナップショットと差分を返す | 全員に全イベントを送らず、将来の空間分割に接続できる |
| 1 ワールド・1 セッション | 既定セッションは `main` | スコープ削減。Store はセッション ID で分けられる |
| 認証なし | 表示名のみ。ケーパビリティは構造上の制約 | プロトタイプの目的外。公開運用には認証と entity 認可が必要 |
| 永続化なし | ワールド状態はメモリのみ。サーバー再起動で消える | プロトタイプの割り切り。Kubo の pin / ブロックは残り得る |
| 画像は IPFS で共有 | WebSocket (JSON, 4KB 上限) には載せず、CID だけを送る | 大きなバイナリでリアルタイム同期を詰まらせない。内容アドレスなので改ざんできず、同じ画像は同じ CID になる |
| サーバーが検証して pin | `create` の CID を Kubo から取得・検証 (サイズ・形式) してから配置する | 不正なデータを全員に配らない。置いた人が退室しても Kubo が提供元になる |
| つかみは排他ロック | `interaction.heldBy` を持つ本人の `space.*` patch だけを受け付ける | 同時に動かされてオブジェクトが飛び回るのを防ぐ。切断時に必ず解放する |
| 保持は参照カウント | 同じ CID を指すオブジェクトが複数あっても 1 つだけ保持し、最後の参照が消えたら unpin + GC | ディスクを使い切らない。複製・再投入で容量が増えない |
| 大きなファイルはブラウザにコピーを作らない | アップロード中のファイルはブロックを保存せず、Kubo が取りに来たら元ファイルから読んで渡す | IndexedDB は遅く、メモリに置くとファイルサイズ分を使う。コピーを作らなければどちらも要らない |
| 大きなファイルは置いた後に取得する | 16MiB を超えるファイルは `stored: false` で先に置き、サーバーが Kubo 経由でバックグラウンド取得する | 置いた人がいつ退室するか分からない。2 GiB の取得は約 1 分かかる |
| サイズと種類はサーバーが決める | `content.size` は実際に取得したバイト数、`content.category` は名前と先頭バイトから判定する | 表示や容量の計算を偽られない |
| ブラウザ同士は WebRTC で直接接続 | 入室後に `peer.ipfsPeerId` を共有し、既存の参加者が新しい参加者へ中継経由で WebRTC 接続する | Kubo の負荷と単一障害点を減らす。通らない環境では Kubo 経由で取得できる |
| 旧 CRDT は削除 | サーバーもクライアントも v2 のサーバー権威モデルに一本化 | 二重の状態機械を残さない。歴史的設計は [CRDT 実験モード](crdt-experiment.md) |

## 8. 想定する制約・リスク

- WebSocket (TCP) は遅延・ジッタに弱く、人数が増えると限界がある。まずは数人〜十数人を想定する。
  将来的に WebRTC DataChannel / WebTransport への移行を検討する。
- 状態同期の見た目の品質は補間実装に依存する (`design.md` 参照)。
- WebXR 対応は端末・ブラウザ依存が大きい。デスクトップ操作は常に併存させる。
- ブラウザ内 IPFS (Helia / libp2p) の制約:
  - **安全なコンテキストが必須**: Web Crypto (`crypto.subtle`) を使うため、HTTPS か `localhost` でしか動かない。
    `http://<LAN の IP>` で開くと `crypto.subtle` が undefined になり、IPFS を起動できない。
    クライアントは起動前にこれを検出して HUD に原因を表示する。対処は README を参照。
  - ブラウザから接続できるのは WebSocket / WebRTC のみ。開発 VPS では Caddy が `wss://HOST:8443` で TLS を終端する。
  - ブラウザ同士の直接接続 (WebRTC) には STUN が必要で、NAT が厳しい環境では TURN の中継が必要になる。
    VPS に coturn を置き、サーバーが入室ごとに時間制限つきの認証情報 (TURN REST API) を配る。
    TURN が使えない環境 (3478 が通らないなど) でも、Kubo 経由 (bitswap) で画像は取得できる。
  - 中継の予約は切断しても有効期限まで残る。ブラウザはページを開くたびに新しいピア ID になる。
- Kubo の制約:
  - **API (5001) は localhost のみ**。外部に出すと pin / add / repo 操作を誰でも実行できる。
  - ゲートウェイ (8082) も外部公開しない。`/media` は proto-server が Range 単位で中継する。
  - ワールド状態はメモリのみなので、サーバー再起動後に参照のない pin が残ることがある。
    必要なら `ipfs pin ls` と `ipfs repo gc` で整理する。
- 任意のファイルを誰でもアップロードできる (1 個 2 GiB、合計 20 GiB まで)。
  16MiB 以下のファイルは、置いた人が退室しても、削除されるかサーバーが再起動するまで Kubo が保持して配り続ける。
  16MiB を超えるファイルは、置いたあとサーバーが取得を終えるまで (2 GiB で約 1 分) は、置いた人のタブが配る。

## 9. CRDT (歴史的設計・コード削除済み)

`crdt-v1` のサーバー実装とクライアントコード (`packages/world-sync`, `crdt.ts`, `crdtP2P.ts`) は
space v2 への移行に伴い削除した。現在の同期はサーバー権威の `Space.Store` / Reader / Writer で行う。
当時の設計・保証範囲・障害試験は [CRDT 実験モード](crdt-experiment.md) を参照 (歴史的資料)。
