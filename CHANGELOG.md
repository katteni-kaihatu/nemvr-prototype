# Changelog

このプロジェクトの主な変更を記録する。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。

## [Unreleased]

### Added

- 画像ファイルのドラッグ&ドロップで 3D 空間に画像を置く機能 (M2)。
  - サーバー: 同じポートで HTTP を提供し、`POST /images` でアップロード、`GET /images/:id` で配信。
    形式はマジックナンバーで判定 (PNG / JPEG / GIF / WebP)。SVG は拒否。
    上限: 1 枚 5MB、保持 50 枚、オブジェクト 100 個。
  - プロトコル: `place_image` (client → server)、`object_added` (server → client)、
    `welcome` に `objects` を追加 (後から入室した人にも見える)。
  - クライアント: ドロップ位置から床へ raycast して配置 (当たらない場合は正面 4m)。
    置いた人の方を向き、長辺 2.5m に正規化。複数ファイルは横並び。
    非画像・大きすぎる・読み込めない・アップロード失敗は HUD に表示。
  - 単体テスト (形式判定、`ImageStore`、`place_image` の検証) を追加。
- 設計ドキュメント (`docs/architecture.md`, `docs/design.md`, `docs/milestones.md`) と README。
- pnpm workspace の構成 (`apps/client`, `apps/server`, `packages/protocol`)。
- `packages/protocol`: client / server 間で共有するメッセージ型と定数。
- `apps/server`: `ws` による WebSocket サーバー。
  - 入室 (`join` / `welcome` / `peer_joined`) と退室 (`peer_left`)。
  - 受信した姿勢を保持し、20Hz のスナップショットで全員に配信。
  - 受信メッセージの検証 (数値の有限性・範囲、名前の長さ、クォータニオンの正規化、サイズ上限)。
  - ping / pong による無応答接続の切断。
- `apps/client`: Vite + React Three Fiber のクライアント。
  - 表示名を入力する入室画面。
  - WASD + Pointer Lock による一人称移動。
  - 他ユーザーの簡易アバター (名前タグ付き) と、スナップショット補間 (100ms 遅延、slerp) による表示。
- 単体テスト (サーバーの入力検証、クライアントの補間ロジック)。

### Fixed

- `pnpm dev` がシェルの glob 展開により起動に失敗する問題 (`--filter` のパターンを引用符で囲んだ)。
- 既に誰かがいる部屋に入室したとき、その人の名前タグが表示されない問題。
  drei の `Html` が `Canvas` の初回レンダーと同時にマウントされると消えていたため、
  canvas テクスチャの `Sprite` による名前タグに置き換えた (高さ 0.3m)。

### Notes

- マイルストーン M0 / M1 に相当。ヘッドレス Firefox (puppeteer-core) で、2 ブラウザの入室・移動の同期・退室を確認済み。
- 画像配置機能はヘッドレス Firefox で、複数クライアントへの同期・後から入室した人への表示・複数ファイル配置・拒否ケースを確認済み。
- 置いた画像の移動・削除は未対応。画像はサーバーのメモリ上のみに保持し、再起動で消える。
- 認証、永続化、複数ルーム、WebXR、ボイスチャットは未対応。
