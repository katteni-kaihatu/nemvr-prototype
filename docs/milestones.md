# マイルストーン

各マイルストーンは「動くものが手元にある」状態で終わるように区切る。

## M0: 土台 (1 人で 3D 空間を歩ける)

- [x] pnpm workspace の雛形 (`apps/client`, `apps/server`, `packages/protocol`)
- [x] client: Vite + R3F で床・ライト・ボックスを表示
- [x] client: WASD + Pointer Lock で一人称移動

**完了条件**: ブラウザで 3D 空間を歩き回れる。

## M1: 複数ユーザー (本プロトタイプの最初のゴール)

- [x] protocol: メッセージ型・定数の定義
- [x] server: WebSocket 接続、`join` / `welcome` / `peer_joined` / `peer_left`
- [x] server: `pose` 受信、`snapshot` 配信 (20Hz)
- [x] client: 入室画面 (名前入力)
- [x] client: `pose` 送信
- [x] client: 他ユーザーのアバター表示 (名前付き、補間あり)
- [x] 異常系: 切断時の表示、不正メッセージの無視

**完了条件**: 2 つ以上のブラウザタブで入室し、互いのアバターが滑らかに動いて見える。退室するとアバターが消える。

## M2: 画像のドラッグ&ドロップ配置

- [x] protocol: `ImageObject` / `place_image` / `object_added` と定数
- [x] server: `POST /images` / `GET /images/:id` (形式判定・サイズ上限・保持数上限)
- [x] server: オブジェクト状態の保持、`welcome` での配信、`place_image` の検証
- [x] client: ドロップ位置の床へ配置 (raycast)、複数ファイルの横並び配置
- [x] client: 置かれた画像の描画、エラー通知 (HUD)

**完了条件**: 画像をドロップするとその場に立ち、他のユーザー (後から入室した人も) にも見える。

> 画像の受け渡しは当初 HTTP (`POST /images`) で実装し、M3 で IPFS に置き換えた。
> M3 当時のサーバーは Helia を埋め込んでいたが、現在は Kubo に置き換え済み (M6.5)。

## M3: 画像の共有を IPFS に

- [x] protocol: `imageId` を `cid` に置き換え、`welcome.ipfs` / `ipfs_peer` / `peer_ipfs` を追加
- [x] server: Helia ノード (libp2p ws / circuit relay)、`place_image` の CID を取得・検証 (サイズ・形式) して pin (現在は Kubo が担当)
- [x] server: HTTP の画像アップロード / 配信を廃止
- [x] client: ブラウザ内 Helia ノード、画像を CID 化して追加、CID から取得してテクスチャ化
- [x] client: ブラウザ同士の WebRTC 直接接続 (ピア ID 共有、HUD に接続数)

**完了条件**: 画像が IPFS 経由で共有され、置いた人が退室しても後から入室した人に見える。WebRTC が通る環境ではブラウザ間で直接取得でき、通らない環境でもサーバー経由で動く。

## M4: オブジェクトの操作

- [x] protocol / server: つかむ・移動・離す・削除・複製 (`grab_object` / `move_object` / `release_object` / `delete_object` / `duplicate_object`)、`object_updated` / `object_removed`
- [x] server: つかみの排他制御 (他の人がつかんでいるものはつかめない・削除できない、切断で自動解除)
- [x] client: 画面中央の白い点 (動いている間と、止まってから 3 秒間だけ表示)
- [x] client: 右ボタン長押しでつかんで運ぶ (楽観的に開始、他の人の画面では補間)
- [x] client: 中ボタンのリングメニュー (削除・複製)、狙っている / つかまれているオブジェクトの輪郭表示

**完了条件**: 画像をつかんで動かすと他のユーザーの画面でも滑らかに動く。メニューから複製・削除でき、全員に反映される。他の人がつかんでいる間は奪えない。

## M5: 任意のファイルの配置とダウンロード

- [x] protocol: `FileObject` / `place_file` / `FileCategory`、種類の判定・ファイル名の整形・サイズ表記 (`files.ts`)
- [x] server: `place_file` (取得・検証・実測のサイズ・種類の判定)、サイズ上限 (ファイル 2 GiB)
- [x] server: `ContentStore` (参照カウント、合計容量の上限 20 GiB、宣言サイズでの事前予約、削除で unpin + gc、gc と取得の排他)
- [x] client: ファイルのドロップ (画像かファイルかの振り分け)、ファイルの形のアイコン (音声・映像は専用)
- [x] client: リングメニューの「ダウンロード」(進捗表示)、メニュー中心の名前とサイズ
- [x] 大きなファイルの取り込み: 16MiB を超えるファイルは、先に置き、サーバーがバックグラウンドで取得する (`request_file`、`prepare_progress`、`FileObject.stored/owner/offline`)。ダウンロードは直接取得を先に試し、取得元の内訳を表示する

**完了条件**: 任意のファイルをドロップするとアイコンとして置かれ、全員に見える。音声・映像は種類が分かるアイコンになる。メニューからダウンロードでき、内容が元のファイルと一致する。削除するとサーバーのメモリが空く。

## M6: CRDT による停止耐性の検証 (歴史的・サーバーでは未対応)

> **注意**: このマイルストーンは Node サーバー時代の実験。Elixir/OTP サーバーは `crdt-v1` を実装していないため、
> 現在の構成では動作しない。設計・障害試験は [CRDT 実験モード](crdt-experiment.md) を参照 (歴史的資料)。

サーバー停止・通信分断中も基本編集を続け、復旧後に統合できるかを検証する。当時は既定の legacy モードを変更せず、
`crdt-v1` を明示した実験環境だけで動かしていた。

- [x] `packages/world-sync`: Yjs 文書・作成/移動/複製/削除・projection・共通フレーム
- [x] server (当時): 専用保存領域 (`meta.json` / `doc.bin` / `content.json` / `blocks/`)・`worldId`・初回 seed・復元失敗の明示
- [x] client: IndexedDB 保存・初期復元・再接続/再同期・HUD の状態表示・オフラインで使える実験用ボックス / リンク配置ボタン
- [x] P2P: 既存 WebRTC / circuit relay 上の `/proto/world-sync/1.0.0` の実装 (サーバー停止中の生存は未検証)
- [x] content: 永続台帳・明示リセットまでの pin・20 GiB 上限・取得不能表示と再試行
- [ ] E2E: 3 browser contexts・100 objects の障害試験と legacy モードの回帰

**現状**: サーバー側の crdt-v1 とクライアントの CRDT コードは削除済み。M6 は現在のバックエンドの完了条件には含めない。

## M6.5: Elixir/OTP バックエンドへの置き換え (実装済み)

Node.js + `ws` のサーバーを、Elixir/OTP (Cowboy) の GenServer 群に置き換える。

- [x] Mix プロジェクト (`apps/server/mix.exs`)、Cowboy の単一リスナー、runtime 設定 (`HOST` / `PORT` / Kubo / TURN)
- [x] GenServer: `ProtoServer.Space.Store` / `Content` / `Queue` / `Place` / `Ipfs`
- [x] space v2 プロトコル (`space_join` / `space_query` / `space_subscribe` / `space_mutate` / `space_import_url` / `space_set_avatar` / `file_request`)
- [x] `/media/<cid>` の Range ストリーミング (Kubo ゲートウェイ経由)
- [x] IPFS を Kubo に委譲 (HTTP API 5001 / ゲートウェイ 8082 / libp2p ws 8081)。`space_welcome.ipfs` に Kubo の peer ID と `IPFS_PUBLIC_PORT` を載せる
- [x] crdt-v1 のサーバー実装とクライアントコードを削除
- [x] Nix flake (`nix develop`)、`scripts/smoke-ws.mjs`、デプロイスクリプト (Kubo + release + Caddy)
- [x] Kubo を接続したメディア E2E (画像・動画の取得、pin / unpin / GC、Range)。ローカルの `ipfs daemon --offline` で確認済み
- [ ] 開発 VPS での `wss://HOST:8443` 経由の libp2p と、2 ブラウザでの WebRTC 目視確認

**完了条件**: 上記の未検証項目を、Kubo を起動した開発 VPS 構成で確認する。

## M6.6: n次元クライアント基盤 (space v2、実装済み)

`docs/n-dim-client-original.md` の基盤部分を実装する。

- [x] 共有次元スキーマ (`packages/protocol/space-schema.json`)
- [x] `Space.Store`: セッション単位のエンティティストア、version、購読、フィルタ、上限、seed
- [x] `Space.Reader` / `Space.Writer`: 接続ごとのプロセス、スナップショット / 差分、20Hz バッチ、`seq`
- [x] `Space.Scope`: 読み書き次元・フィルタ・作成/削除可否・上限のケーパビリティ
- [x] クライアントの `SpaceReader` / `SpaceWriter` と `vr-sns-3d@1` 写像
- [x] 旧 WebSocket プロトコルと CRDT 経路の削除
- [ ] WASM UGC、ユーザー定義写像、動的分割、リードレプリカ、永続化、認証 (次段階)

**完了条件**: 既存の 3D 機能が space v2 上で動き、`pnpm typecheck` / `pnpm test` / `pnpm smoke:ws` が通る。

## M7 以降 (候補。着手前に再検討する)

| MS | 内容 | 検証したいこと |
|---|---|---|
| M7 | WebXR 対応 (HMD・コントローラ移動、頭と手の同期) | Quest ブラウザ等で没入できるか |
| M8 | ボイスチャット (距離減衰) | WebRTC / SFU の導入コストと遅延 |
| M9 | glTF / VRM アバター | 外部アバターの読み込み・同期 |
| M10 | 画像・ファイル以外のオブジェクトの生成、回転・拡大縮小 | 「その場で作る」体験の最小形 |
| M11 | 複数ルーム・永続化 | 運用に必要な最低限の構造 |

## 判断メモ

- M1 まで終わった時点で、体感品質 (遅延・滑らかさ) と開発の手応えを見て、M7 以降の優先順位を決める。
