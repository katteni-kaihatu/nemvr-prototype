Proto SNS - Windows ビルド
==========================

ネイティブ Bevy クライアント (x86_64) です。

必要環境
--------
- Windows 10 / 11 (64-bit)
- GPU ドライバ (Vulkan または DirectX 12)
- ネットワーク接続

起動
----
1. このフォルダを任意の場所に置く。
2. コマンドプロンプトまたは PowerShell で実行する。

   proto-client.exe --server ws://127.0.0.1:8080/ws

`--name` を付けるとロビーを飛ばして接続します。

   proto-client.exe --server ws://127.0.0.1:8080/ws --name alice

引数なしで起動するとロビーが開きます。サーバー URL はロビーの設定ではなく
起動引数で指定してください。

動作確認
--------
   proto-client.exe --help
   proto-client.exe --headless --server ws://127.0.0.1:8080/ws --name test --duration 3

保存先
------
- 設定: %APPDATA%\proto\proto-client\config.json
- キャッシュ / IPFS: %LOCALAPPDATA%\proto\proto-client\

注意
----
- コード署名はしていません。SmartScreen の警告が出る場合があります。
- インストーラ、自動更新はありません。
- このビルドは Linux 上で MinGW-w64 を使ってクロスコンパイルしたものです。
  実機の Windows での GPU / 音声 / IME の確認は別途必要です。
- VRM / XR / 動画は未実装です。
