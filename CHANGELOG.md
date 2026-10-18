# Changelog

このプロジェクトの主な変更を記録する。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。

## [Unreleased]

### Added

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

### Notes

- マイルストーン M0 / M1 に相当。ブラウザ上での描画・操作・複数タブでの同期は手動で確認済み。
- 認証、永続化、複数ルーム、WebXR、ボイスチャットは未対応。
