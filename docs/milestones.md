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

## M6 以降 (候補。着手前に再検討する)

| MS | 内容 | 検証したいこと |
|---|---|---|
| M6 | WebXR 対応 (HMD・コントローラ移動、頭と手の同期) | Quest ブラウザ等で没入できるか |
| M7 | ボイスチャット (距離減衰) | WebRTC / SFU の導入コストと遅延 |
| M8 | glTF / VRM アバター | 外部アバターの読み込み・同期 |
| M9 | 画像・ファイル以外のオブジェクトの生成、回転・拡大縮小 | 「その場で作る」体験の最小形 |
| M10 | 複数ルーム・永続化 | 運用に必要な最低限の構造 |

## 判断メモ

- M1 まで終わった時点で、体感品質 (遅延・滑らかさ) と開発の手応えを見て、M6 以降の優先順位を決める。
