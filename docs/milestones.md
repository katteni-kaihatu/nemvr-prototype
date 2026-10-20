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

## M3: 画像の共有を IPFS に

- [x] protocol: `imageId` を `cid` に置き換え、`welcome.ipfs` / `ipfs_peer` / `peer_ipfs` を追加
- [x] server: Helia ノード (libp2p ws / circuit relay)、`place_image` の CID を取得・検証 (サイズ・形式) して pin
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

## M6: CRDT による停止耐性の検証 (実験)

サーバー停止・通信分断中も基本編集を続け、復旧後に統合できるかを検証する。既定の legacy モードは変更せず、`SYNC_MODE=crdt-v1` / `VITE_SYNC_MODE=crdt-v1` を明示した実験環境だけで動かす。設計・保証範囲・試験項目は [CRDT 実験モード](crdt-experiment.md) を参照。

- [x] `packages/world-sync`: Yjs 文書・作成/移動/複製/削除・projection・共通フレーム
- [x] server: 専用保存領域 (`CRDT_DATA_DIR`)・atomic snapshot・`worldId`・初回 seed・復元失敗の明示
- [x] client: IndexedDB 保存・初期復元・再接続/再同期・HUD の状態表示・オフラインで使える実験用ボックス / リンク配置ボタン
- [x] P2P: 既存 WebRTC / circuit relay 上の `/proto/world-sync/1.0.0` の実装 (サーバー停止中の生存は未検証)
- [x] content: 永続台帳・明示リセットまでの pin・20 GiB 上限・取得不能表示と再試行
- [ ] E2E: 3 browser contexts・100 objects の障害試験と legacy モードの回帰

**完了条件**: WebSocket のみの遮断、Node プロセス停止、P2P のみの遮断、全経路分断、ホスト / TURN 停止、タブ再読み込み・終了、サーバー再起動、コンテンツ提供元の消失をそれぞれ再現し、復旧後に文書が収束すること。100 objects の条件でも編集継続と再統合ができ、legacy モードに回帰がないこと。通信経路と handshake の復旧から 5 秒以内の収束、サーバー復帰から 30 秒以内の自動再接続を目標とし、RTT・TURN 使用・再試行回数を記録する。測定結果が出るまでは合格としない。

**現状**: 実装済み・E2E 未実施。M6 の完了条件はまだ満たしていない (Node / 単体テストの結果は [CRDT 実験モード](crdt-experiment.md) の「15. 検証状況」)。

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
