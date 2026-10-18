# prototype-alternative-resonite-1

VR SNS (Resonite / VRChat 類似) の実現可能性を探るプロトタイプ。
最初のゴールは「複数ユーザーがアクセスできる 3D 空間」。

- スタック: TypeScript / Three.js (React Three Fiber) / Node.js + WebSocket
- ステータス: M1 実装済み (複数ユーザーが入室し、互いのアバターが見える)

## 起動方法

```sh
pnpm install
pnpm dev   # server (ws://localhost:8080) と client (http://localhost:5173) を同時起動
```

ブラウザで `http://localhost:5173` を複数タブで開き、名前を入力して入室する。
クリックで視点操作開始、WASD で移動、Esc で解除。

別ホストの server に繋ぐ場合は `VITE_WS_URL=ws://host:8080` を指定する。

```sh
pnpm typecheck   # 型チェック
pnpm test        # 単体テスト
```

## ドキュメント

- [アーキテクチャ](docs/architecture.md) - スコープ、全体構成、技術選定、設計判断
- [詳細設計](docs/design.md) - プロトコル、同期方式、クライアント / サーバー内部設計
- [マイルストーン](docs/milestones.md) - 段階的な進め方
