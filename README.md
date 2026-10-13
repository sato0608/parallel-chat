# Parallel Chat

Claude を複数の独立したチャットで同時に動かすアプリ（ブラウザ版 / Mac アプリ版）。
各ペインは別々の `claude -p` セッションで、Claude の契約枠で動きます（API キー不要）。

## 機能
- 複数チャットの並列実行（追加・削除・名前変更・リセット）
- Markdown 整形表示（見出し / 表 / コードブロック＋コピー / リンク）
- 画像添付（📎ボタン・貼り付け・ドラッグ&ドロップ、PNG/JPEG/GIF/WebP、5MB・6枚まで）
- ペインごとのモデル選択（既定 / Opus / Sonnet / Haiku）
- ペインごとの作業フォルダ選択（**読み取り専用**: Read/Glob/Grep のみ。編集・コマンド実行は不可）
- 履歴の保存と再起動後の復元

## 前提
- [Node.js](https://nodejs.org/) 22.12 以上（Electron 44 の要件）
- [Claude Code](https://docs.claude.com/en/docs/claude-code) の CLI（`claude` コマンド）がインストール済みで、ログイン済みであること
- Mac アプリ版は macOS（Apple Silicon / arm64）向け。ブラウザ版は `claude` が動く環境なら利用可能

## 使い方
    git clone https://github.com/sato0608/parallel-chat.git
    cd parallel-chat
    npm install
    npm start         # ブラウザ版: http://127.0.0.1:4317
    npm run app       # Electron で起動（開発用）
    npm run dist      # Mac アプリを作成: dist/mac-arm64/Parallel Chat.app
    npm run dmg       # 配布用 .dmg を作成

作った `Parallel Chat.app` を /Applications に入れて使います。
署名していないため、別の Mac に渡す場合は初回に「右クリック → 開く」が必要です。

## データの場所
- ブラウザ版: ./data
- Mac アプリ版: ~/Library/Application Support/parallel-chat/data

## 仕組み
- ペインごとに専用の空フォルダで claude を起動し、`--resume <session_id>` で会話を継続
- 画像は stream-json 入力の image ブロックとして送信
- 設定ファイルは一切読み込まない（選んだフォルダの .claude/settings.json の hook も実行されない）。MCP・スラッシュコマンドも無効
- ツールはフォルダ未選択なら WebSearch/WebFetch のみ、選択時は Read/Glob/Grep を追加。選んだフォルダの外は読めない
- フォルダを変えると Claude のセッションが別になるため、そのペインの会話はリセットされる

## ライセンス

[MIT License](LICENSE)
