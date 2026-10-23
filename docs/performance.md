# Performance

2026-10-24 に Linux AppImage (Godot 4.6.3, Forward+) で測定した。

- GPU: AMD Radeon RX 5700 XT (RADV NAVI10)
- CPU / OS: 開発機 / Linux
- シーン: VPS の共有ワールド、`--scenario place` の箱、既存オブジェクト
- 計測: `--benchmark 8` の 8 秒間。最初の 1 秒はウォームアップとして除外
- 1920x1080 は vsync 有効。3840x2160 は `--disable-vsync` で上限を外した

| Quality | 解像度 | 平均 FPS | 最低 FPS | 平均フレーム時間 |
|---|---:|---:|---:|---:|
| High | 1920x1080 | 58.7 | 28 | 17.0 ms |
| Medium | 1920x1080 | 58.5 | 31 | 17.1 ms |
| Low | 1920x1080 | 58.7 | 31 | 17.0 ms |
| High | 3840x2160 | 177.5 | 69 | 5.63 ms |
| Medium | 3840x2160 | 224.9 | 89 | 4.45 ms |
| Low | 3840x2160 | 503.5 | 197 | 1.99 ms |

1080p は vsync で 60 FPS に張り付くため、プリセット差は 4K の値で比較する。
High は平面反射をフル解像度で描き、SSAO / グロー / フォグ / 影を有効にする。
Medium は反射を 0.6 倍、3D スケールを 0.85 にし、Low は反射・SSAO・グロー・フォグを
無効化して 3D スケールを 0.7 にする。

## 再計測

```sh
cd dist
./ProtoSNS-godot-x86_64.AppImage --resolution 3840x2160 --disable-vsync -- \
  --server wss://nemvr.nemnomi.dev/ws --name bench --quality high \
  --scenario place --benchmark 8 --hide-hud
```

`benchmark` イベントに `avgFps` / `minFps` / `maxFps` / `avgFrameMs` が出る。
`--quality` は `high` / `medium` / `low`。通常起動では Lobby の画質選択に保存される。
