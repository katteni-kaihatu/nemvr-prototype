# Changelog

このプロジェクトの主な変更を記録する。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠する。

## [Unreleased]

### Added

- TURN サーバー (coturn) による WebRTC の中継。別マシンのブラウザ同士が NAT などで直接つながれず `P2P 0` のままになる問題への対応。
  - VPS: `deploy/setup-vps.sh` が coturn を導入・設定する。認証は共有秘密による時間制限つき認証情報 (TURN REST API)。
    共有秘密は初回に生成して `/etc/proto/server.env` に置き (再実行しても変えない)、coturn とアプリで共有する (root と各サービスだけが読める)。
    内部ネットワーク宛ての中継を拒否 (`denied-peer-ip`)、割り当て数・帯域・中継ポート範囲 (UDP 49160-49200) を制限。
    ufw で 3478 (TCP / UDP) と中継ポート範囲を許可する。
  - サーバー: 環境変数 `TURN_HOST` / `TURN_SECRET` (`TURN_PORT`, `TURN_TTL_SECONDS`) を設定すると、入室 (`welcome`) のたびに
    `iceServers` (STUN と、ユーザーごとの有効期限つき TURN 認証情報) を配る。共有秘密はクライアントに渡らない。未設定なら従来どおり (公開 STUN のみ)。
  - クライアント: 受け取った `iceServers` を libp2p の WebRTC に渡す。ページに `?ice=relay` を付けると中継 (TURN) だけを使う (診断用)。
  - プロトコル: `welcome` に `iceServers?` を追加。
  - テスト: 認証情報の形式・有効期限・ユーザーごとの違い・秘密が漏れないことの単体テストを追加。

- VPS へのデプロイ構成 (`deploy/`, `docs/deploy.md`)。Caddy が TLS を終端し、`https://HOST/` (静的ファイル)、`wss://HOST/ws` (ワールド同期)、
  `wss://HOST:8443` (IPFS / libp2p) を公開する。アプリ本体は非 root の systemd サービスとして 127.0.0.1 でのみ待ち受ける。
  - `deploy/setup-vps.sh`: Node.js (公式 tarball を SHA256 検証) / pnpm / Caddy / ufw の導入、ユーザー・サービス・Caddyfile・ファイアウォールの設定 (冪等)。
  - `deploy/deploy.sh`: ビルド → rsync → VPS で依存導入 → 再起動。
  - サーバー: 環境変数 `HOST` (待ち受けアドレス)、`IPFS_PUBLIC_PORT` (ブラウザから見た libp2p のポート) を追加。
    リバースプロキシの背後では全クライアントが同一ホストに見えるため、libp2p の同一ホストからの受信接続の上限 (既定 1 秒 5 件) を 100 に引き上げた。
  - クライアント: HTTPS で開かれたときは、ワールド同期を `wss://<オリジン>/ws`、libp2p を `/tls/ws` で接続する (HTTP の挙動は従来どおり)。
  - 開発時のみ `window.__net` (ストア) を公開 (E2E 用)。

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

- TURN をインターネット越しで確認済み: 3478 (TCP / UDP) と中継ポート範囲 (UDP 49160-49200) に外から通信が届く (ufw のカウンターで確認)。
  公開 URL に対して、同じマシンの 2 つのヘッドレス Firefox を **既定設定のまま** (ローカルのアドレスを mDNS で隠すため、以前は `ICE failed` で `P2P 0` だった)
  通常どおり開く場合も、`?ice=relay` (中継のみ) の場合も `P2P 1` になり、画像の配置と、退室後に入室した人への表示が動く。
  別々のマシン・ネットワークのブラウザ同士での確認は未実施 (環境によっては TURN でも通らないことがある。TLS (5349 / 443) には未対応で、3478 しか通らない網では使えない)。
- VPS (`https://172-104-89-28.ip.linodeusercontent.com/`) へのインターネット公開を確認済み: Let's Encrypt の証明書が自動取得され (HTTP/2、http → https へ 308)、
  `wss://HOST/ws` と `wss://HOST:8443` (libp2p) が通る。公開 URL に対してヘッドレス Firefox で、入室・IPFS 接続・画像の配置・退室後に入室した人への表示を確認した
  (WebRTC が通る場合は P2P 1、通らない場合はサーバー経由で画像が表示される)。
  公開には VPS の手前のネットワーク (Linode の Cloud Firewall 等) で受信 TCP 80 / 443 / 8443 の許可が必要だった (ufw だけでは届かない)。
  実機のブラウザ (別マシン・Chrome 系) からの確認は未実施。
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
