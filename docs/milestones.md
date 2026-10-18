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

## M3 以降 (候補。着手前に再検討する)

| MS | 内容 | 検証したいこと |
|---|---|---|
| M3 | WebXR 対応 (HMD・コントローラ移動、頭と手の同期) | Quest ブラウザ等で没入できるか |
| M4 | ボイスチャット (距離減衰) | WebRTC / SFU の導入コストと遅延 |
| M5 | glTF / VRM アバター | 外部アバターの読み込み・同期 |
| M6 | 画像以外のオブジェクトの生成、移動・削除 | 「その場で作る」体験の最小形 |
| M7 | 複数ルーム・永続化 | 運用に必要な最低限の構造 |

## 判断メモ

- M1 まで終わった時点で、体感品質 (遅延・滑らかさ) と開発の手応えを見て、M3 以降の優先順位を決める。
