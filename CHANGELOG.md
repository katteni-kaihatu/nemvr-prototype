# Changelog

このプロジェクトの主な変更を記録する。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。

## [Unreleased]

### Added

- 画像の同期・共有に IPFS (Helia 7 + libp2p) を使用 (M3)。
  - サーバー: Helia ノードを同じプロセスで起動 (libp2p WebSocket :8081、既定。`IPFS_PORT` で変更)。
    ブラウザの接続先、circuit relay、pin 済み画像の提供元を兼ねる。
    `place_image` の CID を取得して検証 (5MB 上限・PNG / JPEG / GIF / WebP のみ・20 秒タイムアウト) し、pin してから配置する。
    置いた人が退室しても、後から入室した人に画像が見える。
  - クライアント: ブラウザ内で Helia ノードを起動してサーバーに接続。画像を CID 化して追加し、CID から取得してテクスチャにする。
  - ブラウザ同士の直接接続 (WebRTC): 入室後に libp2p ピア ID を `ipfs_peer` / `peer_ipfs` で共有し、
    既存の参加者が新しい参加者へ中継経由で接続する。HUD に IPFS の状態と直接接続数 (`P2P n`) を表示。
    接続できない環境でもサーバー経由で動く。
  - プロトコル: `welcome` に `ipfs` (サーバーの libp2p 接続情報) を追加、`ipfs_peer` / `peer_ipfs` を追加。
  - 開発時のみ `window.__ipfs` (`addImage` / `getImageUrl`) を公開 (動作確認・E2E 用)。
  - テスト: サーバーの Helia ノードとクライアント相当のノードをプロセス内で動かす結合テストを追加
    (取得・検証・pin、非画像 / サイズ超過 / 取得不能の拒否、同じ画像の再配置、中継予約の上限)。

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

### Changed

- **破壊的変更**: 画像の識別子を `imageId` (UUID) から `cid` に変更。HTTP の画像アップロード / 配信
  (`POST /images`, `GET /images/:id`) と、保持数の上限 (`MAX_IMAGES`)、CORS 全許可の設定を廃止。
  サーバーが提供するのは WebSocket と IPFS (libp2p) のみ。

### Fixed

- `http://<LAN の IP>` で開いたブラウザで IPFS の起動に失敗し、原因が分からない問題。Helia / libp2p が Web Crypto (`crypto.subtle`) を使うが、
  ブラウザは HTTPS か localhost にしか提供しないため。起動前に検出して、HUD に原因と対処 (localhost か HTTPS で開く) を表示するようにした。
  対処方法 (ポート転送、Firefox / Chrome の許可設定) は README に記載。許可設定を入れた状態で、LAN の IP アドレスでも IPFS と P2P 接続が動くことを確認済み。
  `crypto.subtle.digest` だけを補うフォールバックは、`importKey` などでも失敗するため採用しなかった。
- IPFS のエラーがコンソールで `JSHandle@error` としか読めなかったため、`name: message (cause)` の文字列でも出すようにした。
- 同じ画像を 2 回置こうとすると、2 回目が失敗する問題 (pin 済みの CID を再度 pin すると `AlreadyPinnedError` になっていた)。
- 中継 (circuit relay) の予約が既定の 15 件で頭打ちになり、新しい参加者の直接接続ができなくなる問題。
  予約は切断しても有効期限 (2 時間) まで残り、ブラウザはページを開くたびに新しいピア ID になるため、上限を 1000 に引き上げた。

- `pnpm dev` がシェルの glob 展開により起動に失敗する問題 (`--filter` のパターンを引用符で囲んだ)。
- 既に誰かがいる部屋に入室したとき、その人の名前タグが表示されない問題。
  drei の `Html` が `Canvas` の初回レンダーと同時にマウントされると消えていたため、
  canvas テクスチャの `Sprite` による名前タグに置き換えた (高さ 0.3m)。

### Notes

- マイルストーン M0 / M1 に相当。ヘッドレス Firefox (puppeteer-core) で、2 ブラウザの入室・移動の同期・退室を確認済み。
- 画像配置機能はヘッドレス Firefox で、複数クライアントへの同期・後から入室した人への表示・複数ファイル配置・拒否ケースを確認済み。
- IPFS: WebRTC が通る環境では、サーバーが持たない画像をブラウザ間で直接取得できること (サーバーを介さないと取得に失敗することも比較して確認)、
  通らない環境ではサーバー経由で画像が配置・表示されることを確認済み。
  ヘッドレス Firefox で WebRTC を通すには、テスト用に `media.peerconnection.ice.obfuscate_host_addresses=false` が必要だった (mDNS が解決できないため)。
- **IPFS 経由の通信は、開発者の手元の環境では未確認**。確認できたのはヘッドレス Firefox 上のテスト (上記) のみで、
  実機のブラウザ (特に別マシン・Chrome 系) での動作は未検証。`http://<LAN の IP>` で開いた場合は IPFS を使えない (HUD に原因を表示)。
- 制約: IPFS は HTTPS か localhost のページでのみ動作 (Web Crypto が必要)、`ws://` のみ (https ページからは接続不可)、
  STUN は libp2p の既定 (公開 STUN) に依存、TURN なし、ブロックストアはメモリ上。
- 置いた画像の移動・削除は未対応。画像はサーバーのメモリ上のみに保持し、再起動で消える。
- 認証、永続化、複数ルーム、WebXR、ボイスチャットは未対応。
