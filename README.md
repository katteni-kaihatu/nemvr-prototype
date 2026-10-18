# prototype-alternative-resonite-1

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
最初のゴールは「複数ユーザーがアクセスできる 3D 空間」。

- スタック: TypeScript / Three.js (React Three Fiber) / Node.js + WebSocket
- ステータス: M3 実装済み (複数ユーザーが入室し、画像をドラッグ&ドロップで 3D 空間に置ける。画像は IPFS で共有)

## 起動方法

```sh
pnpm install
pnpm dev   # server (ws://localhost:8080 と IPFS ノード :8081) と client (http://localhost:5173) を同時起動
```

ブラウザで `http://localhost:5173` を複数タブで開き、名前を入力して入室する。
クリックで視点操作開始、WASD で移動、Esc で解除。
画像ファイル (PNG / JPEG / GIF / WebP, 5MB まで) を画面にドラッグ&ドロップすると、
ドロップ位置の床に置かれ、全員に表示される (視点操作中は Esc で解除してからドラッグする)。
画像は IPFS で共有される。ドロップした画像はブラウザ内の IPFS ノード (Helia) で CID になり、
サーバーの IPFS ノードが取得・検証・pin する。他のブラウザは CID から取得する
(WebRTC で直接つながればブラウザ同士、つながらなければサーバー経由)。HUD の `P2P n` は直接接続の数。
サーバーの再起動で pin した画像は消える (ブロックストアはメモリ上)。

### 別マシンのブラウザから使う場合

ポート 5173 / 8080 / 8081 に到達できる必要がある。さらに、**IPFS は「安全なコンテキスト」でしか動かない**。
Helia / libp2p が Web Crypto (`crypto.subtle`) を使うためで、ブラウザはこれを HTTPS か `localhost` にしか提供しない。
そのため別マシンから `http://<サーバーの IP>:5173` で開くと、HUD に「IPFS: 接続失敗」と原因が表示され、画像を共有できない
(入室・移動・他の人の表示は動く)。次のいずれかで対処する。

- **localhost として開く (推奨)**: 別マシンから SSH のポート転送を張り、`http://localhost:5173` で開く。
  `ssh -L 5173:localhost:5173 -L 8080:localhost:8080 -L 8081:localhost:8081 <サーバー>`
- **開発用にそのオリジンを許可する**:
  - Firefox: `about:config` の `dom.securecontext.allowlist` に、サーバーのホスト (例: `192.168.16.174`) を追加する。
  - Chrome 系: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` に `http://<サーバーの IP>:5173` を追加して有効にする。
- **HTTPS (wss) で配信する**: 現状は未対応 (ページ・ワールド同期・libp2p のすべてに TLS が必要)。

同じマシンの別タブ / 別ブラウザで `http://localhost:5173` を開く分には、そのまま使える。
なお Firefox はローカルのアドレスを mDNS で隠すため、同じマシン上のブラウザ同士では WebRTC が通らず `P2P 0` のままになることがある
(画像はサーバー経由で共有される)。

別ホストの server に繋ぐ場合は `VITE_WS_URL=ws://host:8080` を指定する。

```sh
pnpm typecheck   # 型チェック
pnpm test        # 単体テスト
```

## ドキュメント

- [アーキテクチャ](docs/architecture.md) - スコープ、全体構成、技術選定、設計判断
- [詳細設計](docs/design.md) - プロトコル、同期方式、クライアント / サーバー内部設計
- [マイルストーン](docs/milestones.md) - 段階的な進め方
- [デプロイ (VPS)](docs/deploy.md) - インターネット公開の構成 (Caddy + HTTPS / wss)、手順、注意点
