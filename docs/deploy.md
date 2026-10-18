# デプロイ (VPS)

開発用の VPS (Ubuntu 26.04) にインターネット公開するための構成と手順。
スクリプトは `deploy/` にある。

## 公開構成

```mermaid
graph LR
    B[ブラウザ] -->|"https://HOST/ (443)"| C[Caddy<br/>TLS 終端]
    B -->|"wss://HOST/ws (443)"| C
    B -->|"wss://HOST:8443 (libp2p /tls/ws)"| C
    C -->|静的ファイル| F["/srv/proto-client"]
    C -->|"/ws"| S1["server :8080<br/>ワールド同期"]
    C -->|":8443"| S2["server :8081<br/>IPFS (libp2p ws)"]
    B <-.->|WebRTC 直接| B2[他のブラウザ]
```

| 公開ポート | 用途 |
|---|---|
| 22/tcp | SSH |
| 80/tcp | ACME (HTTP-01) の検証と、https へのリダイレクト |
| 443/tcp, 443/udp | サイト (静的ファイル) と `wss://HOST/ws` (HTTP/3 用に udp も) |
| 8443/tcp | IPFS (libp2p) の WebSocket。ブラウザは `/tls/ws` で接続する |
| 3478/tcp, 3478/udp | TURN (coturn) の制御と中継 |
| 49160-49200/udp | TURN の中継ポート範囲 |

- **HTTPS が必須**: IPFS (Helia / libp2p) は Web Crypto を使うため、ページが安全なコンテキスト (HTTPS か localhost) でないと動かない
  (`architecture.md` の「想定する制約」参照)。
- **ホスト名が必要**: Let's Encrypt の証明書はホスト名に対して発行される。IP アドレスだけでは取れない。
  Linode の逆引きホスト名 (`172-104-89-28.ip.linodeusercontent.com`) は、その IP アドレスに正引きもできるので、独自ドメインが無くても使える。
  独自ドメインを使う場合は A レコードを VPS の IP アドレスに向けて、`PROTO_HOST` をそのドメインにする。
- アプリ本体は `proto` ユーザー (非 root) の systemd サービス `proto-server` として 127.0.0.1 のみで待ち受ける。外に出るのは Caddy だけ。
- クライアントは、HTTPS で開かれたときだけ、ワールド同期を `wss://<オリジン>/ws`、libp2p を `/dns4/<host>/tcp/<IPFS_PUBLIC_PORT>/tls/ws/...` に接続する
  (`apps/client/src/net/connection.ts`, `ipfs.ts`)。HTTP (開発時) の挙動は変わらない。

## サーバーの環境変数

| 名前 | 既定値 | 説明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 待ち受けアドレス。リバースプロキシの背後なら `127.0.0.1` |
| `PORT` | `8080` | ワールド同期 (WebSocket) |
| `IPFS_PORT` | `8081` | libp2p の WebSocket |
| `IPFS_PUBLIC_PORT` | `IPFS_PORT` と同じ | ブラウザから見た libp2p のポート (Caddy の 8443)。`welcome` でクライアントに伝える |
| `TURN_HOST` | (なし) | TURN サーバーのホスト名。`TURN_SECRET` とあわせて設定したときだけ TURN を配る |
| `TURN_PORT` | `3478` | TURN のポート |
| `TURN_SECRET` | (なし) | coturn の `static-auth-secret` と同じ値。クライアントには渡らない |
| `TURN_TTL_SECONDS` | `21600` (6 時間) | 発行する認証情報の有効期間 |

## 手順

### 0. 前提: ネットワークで必要なポートを開ける

**VPS の外側のファイアウォールで、次の受信を許可しておくこと。**

| プロトコル | ポート | 用途 |
|---|---|---|
| TCP | 80, 443, 8443 | サイト、`/ws`、IPFS、証明書の取得 |
| UDP | 443 (任意) | HTTP/3 |
| TCP / UDP | 3478 | TURN |
| UDP | 49160-49200 | TURN の中継ポート |

Linode の場合は Cloud Manager の Firewalls (Network → Firewalls) で、この Linode に割り当てられているルールを確認する。
VPS 内の ufw を開けても、手前のファイアウォールが塞いでいると通信は届かず、証明書も取得できない
(Let's Encrypt の検証が「Timeout during connect (likely firewall problem)」で失敗する)。

確認方法 (手元のマシンから。TURN の UDP は STUN の応答で確認する):

```sh
for p in 80 443 8443 3478; do timeout 6 bash -c "exec 3<>/dev/tcp/<VPS の IP>/$p" 2>/dev/null && echo "$p: open" || echo "$p: no response"; done
```

UDP 3478 は、STUN の Binding Request を送って応答があれば開いている (Node の `dgram` で数行で書ける)。中継ポート範囲 (UDP 49160-49200) は、
実際に TURN 経由で接続して確かめる (後述の `?ice=relay`)。

### 1. VPS を構築する (初回のみ。何度実行しても同じ結果になる)

```sh
ssh root@<VPS> "PROTO_HOST=<ホスト名> bash -s" < deploy/setup-vps.sh
```

Node.js (公式 tarball を SHA256 検証)、pnpm、Caddy、ufw、`proto` ユーザー、systemd サービス、Caddyfile、ファイアウォール (22 / 80 / 443 / 8443) を設定する。

### 2. アプリをデプロイする

```sh
DEPLOY_HOST=root@<VPS> SSH_KEY=~/.ssh/<鍵> deploy/deploy.sh
```

ビルド (型チェック + クライアントのビルド) → `rsync` で転送 → VPS で `pnpm install --frozen-lockfile` → サービス再起動。
クライアントのビルド成果物は `/srv/proto-client`、サーバーのソースは `/opt/proto/app` に置かれる。

### 3. 確認する

```sh
curl -sSI https://<ホスト名>/            # 200
ssh root@<VPS> journalctl -u proto-server -n 20 --no-pager
ssh root@<VPS> journalctl -u caddy --no-pager | grep -E "obtain|certificate"
```

ブラウザで `https://<ホスト名>/` を開き、HUD に「IPFS: 接続済み」と出ることを確認する。

## TURN (WebRTC の中継)

ブラウザ同士が直接つながれない環境 (NAT が厳しい、同じ LAN で折り返し通信ができない、UDP が遮断されているなど) では、WebRTC は TURN で中継する。
VPS に coturn を入れてあり、サーバーが入室 (`welcome`) のたびに ICE サーバー設定 (`iceServers`) を配る。

- **認証**: TURN REST API 方式 (`use-auth-secret`)。`username = <期限の UNIX 秒>:<ユーザー ID>`、`credential = base64(HMAC-SHA1(共有秘密, username))`。共有秘密は `/etc/proto/server.env` と `/etc/turnserver.conf` にだけあり (どちらも root と各サービスだけが読める)、クライアントには渡らない。認証情報の有効期間は 6 時間。`setup-vps.sh` が初回に秘密を生成し、再実行しても変えない。
- **経路**: `turn:HOST:3478?transport=udp` と `?transport=tcp` の両方を配る。TLS (5349 / 443) は未対応のため、3478 が通らない (443 しか通らない) ネットワークでは使えない。
- **悪用対策**: 内部ネットワーク宛ての中継を拒否 (`denied-peer-ip`)、1 ユーザー 8 割り当て・全体 300 割り当て、1 セッション 2MB/秒、中継ポートは 41 個まで。
  ただし認証情報は入室した誰にでも配られるため、公開範囲が広いと中継帯域を使われる可能性がある。
- **診断**: ページを `https://HOST/?ice=relay` で開くと、直接ではなく TURN の中継だけを使う。同じマシンの 2 つのブラウザでも `P2P 1` になれば、TURN が機能している。

## 運用上の注意

- **証明書の取得に失敗している間、Caddy は自動で再試行する** (Let's Encrypt のレート制限を避けるため、途中からステージング環境で試す)。
  ポートを開けた後に急ぐ場合は `systemctl restart caddy`。
- サーバーを再起動すると、置かれた画像とワールドの状態は消える (メモリのみ)。
- 認証がなく、誰でも入室して画像を置ける。オブジェクト数 (100)・画像サイズ (5MB)・同時検証数 (4) の上限があるだけ。公開範囲には注意すること。
- Node / pnpm のバージョンは `deploy/setup-vps.sh` の `NODE_VERSION` / `PNPM_VERSION` で固定している (開発環境と同じ)。

## 検証状況

- 公開 URL `https://172-104-89-28.ip.linodeusercontent.com/` (Linode, Ubuntu 26.04) で確認済み。
  - Let's Encrypt の証明書が自動取得され、HTTP/2、`http://` は `https://` へ 308 リダイレクト。
  - `wss://HOST/ws` で入室でき、`welcome.ipfs.wsPort` は 8443。`https://HOST:8443` は libp2p の WebSocket サーバー (HTTP リクエストには 400) に届く。
  - ヘッドレス Firefox (puppeteer-core) で、入室・IPFS 接続・画像の配置・配置した人が退室した後に入室した人への表示を確認。
    WebRTC が通る場合は `P2P 1`、通らない場合 (`P2P 0`) もサーバー経由 (libp2p wss) で画像が表示される。
  - 手順どおりの再デプロイ (`deploy/deploy.sh`) も確認済み。
  - オブジェクト操作 (M4) をデプロイした公開 URL で、ブラウザの実操作と、Node の観察クライアント (同じ `wss://HOST/ws`) によるサーバーの配信メッセージの確認を行い、
    つかむ・歩いて運ぶ・離す・複製・削除、他のクライアントによるつかみ・削除の拒否まで通ることを確認。
- TURN: coturn の認証 (有効・誤り・期限切れの認証情報) と内部アドレス宛て中継の拒否を VPS 内で確認。
  3478 (TCP / UDP) と UDP 49160-49200 には外から通信が届く (ufw のカウンターで確認)。
  同じマシンの 2 つのブラウザを Firefox の既定設定 (mDNS 有効。TURN なしでは `ICE failed` で `P2P 0`) で公開 URL に接続すると、
  通常でも `?ice=relay` でも `P2P 1` になる。
- 未確認: 別々のマシン・ネットワークのブラウザ同士の接続、実機のブラウザ (Chrome 系)。TURN は TLS 未対応のため、3478 が通らない網では使えない。
