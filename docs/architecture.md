# アーキテクチャ

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
**最初のゴールは「複数ユーザーが同時にアクセスできる 3D 空間」** であり、それ以外は意図的にスコープ外とする。

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
        S["proto-server<br/>Elixir/OTP (Cowboy)<br/>Room / Content / Queue / Place / Ipfs"]
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
- サーバーは Kubo の peer ID を `welcome.ipfs` でクライアントに伝える。クライアントは `IPFS_PUBLIC_PORT`
  (開発 8081 / 本番 8443) と組み合わせて接続先を組み立てる。

## 4. 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| 言語 (client) | TypeScript | 共有型と UI / 3D を同じ言語で扱う |
| 言語 (server) | Elixir / OTP | 軽量プロセスと supervision で、接続ごとの状態と障害分離を素直に書ける |
| パッケージ管理 | pnpm workspace | 共有パッケージを簡単に扱える |
| クライアント | Vite + React + three + @react-three/fiber + @react-three/drei | 宣言的な 3D、開発サイクルが速い |
| XR (後続) | @react-three/xr | WebXR のラッパー |
| サーバー | Elixir/OTP + Cowboy | HTTP と WebSocket を 1 リスナーで扱う。GenServer で Room / Content などを分離 |
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
│  ├─ protocol/         # 共有メッセージ型 (型のみ、実行時依存なし)
│  └─ world-sync/       # 休止中の CRDT クライアントライブラリ
├─ apps/
│  ├─ server/           # Elixir/OTP サーバー (mix.exs / lib / test / config)
│  └─ client/           # Vite + R3F クライアント
└─ deploy/              # VPS 構築・デプロイスクリプト
```

## 6. コンポーネント責務

### server (`apps/server`)

- Cowboy の 1 リスナーで HTTP と WebSocket を受け付ける (`PORT` / `HOST`)。
  `/media/...` は HTTP、それ以外は WebSocket アップグレード。
- 接続ごとにユーザー ID を採番する。
- `join` を受けたらユーザーを登録し、`welcome` を返し、他者へ `peer_joined` を通知する。
- 受信した `pose` を最新値としてメモリ上に保持し、20Hz で `snapshot` を配信する。
- 切断時にユーザーを削除し、`peer_left` を通知する。
- **GenServer の分担**:
  - `ProtoServer.Room`: ピア、オブジェクト、つかみの排他、スナップショット、動画の再生状態。
  - `ProtoServer.Content`: CID の参照カウント、合計容量、pin / unpin / GC の調整。
  - `ProtoServer.Queue`: ピアごとの取得ジョブの直列化と全体の同時実行数。
  - `ProtoServer.Place`: CID の取得・検証・配置 (画像 / ファイル / URL / アバター)。
  - `ProtoServer.Ipfs`: Kubo の HTTP API / ゲートウェイへのアクセス、peer ID の取得。
  - `ProtoServer.Turn` / `UrlFetch` / `Media` / `Protocol`: TURN 認証情報、URL 取り込み、Range / MIME、メッセージ検証。
- `place_image` を受けたら、CID の中身を Kubo から取得して検証 (サイズ上限・画像形式をマジックナンバーで判定) し、
  pin してから `object_added` を全員に通知する。pin しておくので、置いた人が退室した後も Kubo が配り続けられる。
- `ipfs_peer` を受けたら、本人以外に `peer_ipfs` で libp2p ピア ID を知らせる (ブラウザ同士の直接接続用)。
- オブジェクト操作 (`grab_object` / `move_object` / `release_object` / `delete_object` / `duplicate_object`) を受けて、
  状態を更新し、`object_updated` / `object_removed` / `object_added` を配る。つかんでいる間は本人だけが動かせる。
- 最後の参照が消えた CID は unpin し、GC する。合計サイズは `CONTENT_MAX_TOTAL_MB` で制限する。
- 入力値の最低限の検証 (型・数値範囲・名前の長さ) のみ行う。
- **crdt-v1 は実装しない**。`sync_*` / `claim` / `claim_release` を受けたら、接続を切らずに `error` を返す。

### client (`apps/client`)

- 入室画面 (名前入力) → 3D シーン。
- ローカルプレイヤーの入力処理と移動 (クライアント権威)。
- 自分の姿勢を 20Hz で送信。
- 他ユーザーのアバターを `snapshot` から生成・更新・削除し、補間表示する。
- ブラウザ内で Helia ノードを動かし、Kubo (と他のブラウザ) に接続する。
- 画像ファイルのドロップを受け付け、ドロップ位置の床に置く (IPFS に追加 → CID を `place_image` で送る)。
- ワールドのオブジェクト (画像) を CID で IPFS から取得して描画する。
- 画面中央をカーソルにしてオブジェクトを狙い、右ボタンでつかんで運び、中ボタンのリングメニューから削除・複製する。
- `packages/world-sync` に休止中の CRDT コードがあるが、サーバーが対応していないため既定では使わない。

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
| サーバーを Elixir/OTP にする | Room / Content / Queue / Place / Ipfs を GenServer に分ける | 接続・取得・配置の状態をプロセスごとに閉じ込め、障害の影響を局所化できる |
| IPFS を Kubo に委譲する | サーバーは HTTP API とゲートウェイだけを使う | libp2p / bitswap / pin / blockstore の実装を持たずに済む。サーバー再起動でブロックを失わない |
| クライアント権威の移動 | 自分の位置はクライアントが決めて送信 | 実装が簡単。チートは許容 (プロトタイプ) |
| スナップショット配信 | 差分でなく全員分を毎回送る | 実装が単純。人数が少ない前提で帯域は問題にならない |
| 1 ワールド・1 ルーム | ルーム ID を持たない | スコープ削減。将来はルーム ID をメッセージに追加 |
| 認証なし | 表示名のみ | プロトタイプの目的外 |
| 永続化なし | ワールド状態はメモリのみ。サーバー再起動で消える | プロトタイプの割り切り。Kubo の pin / ブロックは残り得る |
| 画像は IPFS で共有 | WebSocket (JSON, 4KB 上限) には載せず、CID だけを送る | 大きなバイナリでリアルタイム同期を詰まらせない。内容アドレスなので改ざんできず、同じ画像は同じ CID になる |
| サーバーが検証して pin | `place_image` の CID を Kubo から取得・検証 (サイズ・形式) してから配置する | 不正なデータを全員に配らない。置いた人が退室しても Kubo が提供元になる |
| つかみは排他ロック | つかんでいる間は、つかんだ本人の `move_object` だけを受け付ける | 同時に動かされてオブジェクトが飛び回るのを防ぐ。切断時に必ず解放する |
| 保持は参照カウント | 同じ CID を指すオブジェクトが複数あっても 1 つだけ保持し、最後の参照が消えたら unpin + GC | ディスクを使い切らない。複製・再投入で容量が増えない |
| 大きなファイルはブラウザにコピーを作らない | アップロード中のファイルはブロックを保存せず、Kubo が取りに来たら元ファイルから読んで渡す | IndexedDB は遅く、メモリに置くとファイルサイズ分を使う。コピーを作らなければどちらも要らない |
| 大きなファイルは置いた後に取得する | 16MiB を超えるファイルは `stored: false` で先に置き、サーバーが Kubo 経由でバックグラウンド取得する | 置いた人がいつ退室するか分からない。2 GiB の取得は約 1 分かかる |
| サイズと種類はサーバーが決める | `size` は実際に取得したバイト数、`category` は名前と先頭バイトから判定する | 表示や容量の計算を偽られない |
| ブラウザ同士は WebRTC で直接接続 | 入室後に libp2p ピア ID を共有し、既存の参加者が新しい参加者へ中継経由で WebRTC 接続する | Kubo の負荷と単一障害点を減らす。通らない環境では Kubo 経由で取得できる |
| crdt-v1 はサーバーで扱わない | クライアントの休止コードは残すが、サーバーは `sync_*` を受け付けない | 実験コードを本番の状態機械から分離する。詳細は [CRDT 実験モード](crdt-experiment.md) (歴史的設計) |

## 8. 想定する制約・リスク

- WebSocket (TCP) は遅延・ジッタに弱く、人数が増えると限界がある。まずは数人〜十数人を想定する。
  将来的に WebRTC DataChannel / WebTransport への移行を検討する。
- 状態同期の見た目の品質は補間実装に依存する (`design.md` 参照)。
- WebXR 対応は端末・ブラウザ依存が大きい。デスクトップ操作は常に併存させる。
- ブラウザ内 IPFS (Helia / libp2p) の制約:
  - **安全なコンテキストが必須**: Web Crypto (`crypto.subtle`) を使うため、HTTPS か `localhost` でしか動かない。
    `http://<LAN の IP>` で開くと `crypto.subtle` が undefined になり、IPFS を起動できない。
    クライアントは起動前にこれを検出して HUD に原因を表示する。対処は README を参照。
  - ブラウザから接続できるのは WebSocket / WebRTC のみ。本番は Caddy が `wss://HOST:8443` で TLS を終端する。
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

## 9. CRDT (歴史的設計)

`crdt-v1` はクライアント側 (`packages/world-sync`) にコードが残っているが、**Elixir/OTP サーバーは実装していない**。
サーバーに CRDT の保存領域・同期メッセージ・モード切替はない。`VITE_SYNC_MODE=crdt-v1` を指定すると、
クライアントはサーバーが対応していない旨のエラーを表示する。
当時の設計・保証範囲・障害試験は [CRDT 実験モード](crdt-experiment.md) を参照 (歴史的資料)。
