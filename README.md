# AiSEG2 ダッシュボード

パナソニック AiSEG2 エネルギーモニター向けのローカル PWA ダッシュボードです。
リアルタイム電力フロー・日次電力集計・分岐回路別使用量の閲覧、およびエアコン・床暖房・エネファームの操作ができます。

---

## 機能

- ⚡ **リアルタイム電力フロー** — 太陽光・エネファームの発電量、消費量、売買電をリアルタイム表示（5秒更新）
- 📊 **日次集計** — 今日の発電・消費・買電・売電の kWh を表示
- 🔌 **回路別使用量** — 38回路の今日の kWh を一覧表示
- 🌡️ **機器コントロール**
  - エアコンA・B・C の個別運転/停止（室内・室外温度・湿度表示付き）
  - エアコンの詳細設定：設定温度（16〜30℃）・モード（自動/冷房/暖房/除湿/送風）・風量（自動/1〜6）
  - 床暖房A・B の個別運転/停止（温度レベル1〜9 のその場変更付き）
  - エネファーム：ふろ自動のON/OFF・発電のON/OFF
- ✏️ **カスタム名称** — エアコン・床暖房の表示名をローカルで自由に変更可能（サーバー側 `nicknames.json` に保存）
- 📱 **PWA** — スマートフォンのホーム画面に追加してネイティブアプリのように使用可能
- 🔁 **オフライン対応** — WebSocket が切断されても REST ポーリングで継続更新。画面復帰時に即時再接続

---

## 必要環境

| 項目 | 要件 |
|------|------|
| Node.js | 18 以上（fetch API 内蔵版） |
| AiSEG2 | ファームウェア Ver.2.x 以降（LAN 接続済み） |
| ネットワーク | ダッシュボードサーバーと AiSEG2 が同一 LAN 上にあること |

---

## セットアップ

### 1. リポジトリの取得

```bash
git clone <このリポジトリ> aiseg2
cd aiseg2
```

### 2. 依存パッケージのインストール

```bash
npm install
```

### 3. 設定の変更（必要な場合）

`aiseg2.js` の先頭にある以下の定数を環境に合わせて変更してください。

```js
const BASE = 'http://192.168.0.216';  // AiSEG2 の IP アドレス
const USER = 'aiseg';                  // ユーザー名（通常変更不要）
const PASS = '1234567890';             // パスワード（AiSEG2 本体で確認）
```

### 4. 起動

```bash
npm start
```

ブラウザで `http://<サーバーIP>:3000` を開きます。

---

## サービスとして常時起動する

### Linux（systemd）

```bash
bash install-linux.sh
```

### macOS（launchd）

```bash
bash install-macos.sh
```

詳細は後述の「ホスティング」セクションを参照してください。

---

## ポート変更

デフォルトは `3000` ポートです。変更するには：

```bash
PORT=8080 npm start
```

または `install-linux.sh` / `install-macos.sh` 内の `PORT` 変数を編集してください。

---

---

# AiSEG2 Dashboard

A local PWA dashboard for the Panasonic AiSEG2 home energy monitor.
View real-time power flow, daily kWh totals, per-circuit usage, and control air conditioners, floor heating, and Enefarm from any device on your LAN.

---

## Features

- ⚡ **Real-time power flow** — Solar, Enefarm generation, consumption, and grid buy/sell updated every 5 seconds
- 📊 **Daily totals** — Today's generation, consumption, purchased, and sold kWh
- 🔌 **Circuit breakdown** — Today's kWh for all 38 branch circuits
- 🌡️ **Device control**
  - Air conditioners A/B/C — individual on/off with indoor/outdoor temp and humidity
  - AC detailed settings: set temperature (16–30 °C), mode (auto/cool/heat/dry/fan), fan speed (auto/1–6)
  - Floor heating A/B — individual on/off with inline level adjustment (levels 1–9)
  - Enefarm — bath hot water (ふろ自動) and power generation on/off
- ✏️ **Device nicknames** — rename any AC or floor heater to a custom label; persisted server-side in `nicknames.json`
- 📱 **PWA** — Add to home screen on iOS/Android for a native app feel
- 🔁 **Resilient** — Falls back to REST polling when WebSocket drops; reconnects immediately on tab focus

---

## Requirements

| | |
|---|---|
| Node.js | 18+ (built-in fetch required) |
| AiSEG2 | Firmware Ver.2.x+, connected to LAN |
| Network | Dashboard server and AiSEG2 must be on the same LAN |

---

## Quick Start

```bash
git clone <this-repo> aiseg2
cd aiseg2
npm install
npm start
```

Open `http://<server-ip>:3000` in a browser on any device on the same network.

---

## Configuration

Edit the constants at the top of `aiseg2.js`:

```js
const BASE = 'http://192.168.0.216';  // AiSEG2 IP address
const USER = 'aiseg';                  // Username (usually unchanged)
const PASS = '1234567890';             // Password (printed on AiSEG2 unit)
```

---

## Hosting as a Service

### Linux (systemd — Arch, Ubuntu, Debian, etc.)

```bash
bash install-linux.sh
```

This installs and starts a systemd user service that survives reboots.

### macOS (launchd — Mac Mini, etc.)

```bash
bash install-macos.sh
```

This installs a LaunchDaemon (system-level) that starts at boot.

See the scripts for configuration options (port, user, install path).

---

## Project Structure

```
aiseg2/
├── aiseg2.js          # AiSEG2 API client (Digest auth, all endpoints)
├── server.js          # Express HTTP + WebSocket server
├── public/
│   ├── index.html     # PWA shell (two-tab layout)
│   ├── style.css      # Dark theme styles
│   ├── app.js         # Frontend JS (WS, REST fallback, device control)
│   ├── sw.js          # Service worker (cache-first for static assets)
│   └── manifest.json  # PWA manifest
├── install-linux.sh   # systemd service installer
├── install-macos.sh   # launchd service installer
├── README.md
└── ARCHITECTURE.md    # AiSEG2 API reverse-engineering notes
```

---

## Development

```bash
npm run dev   # starts server with --watch for auto-reload on file changes
```

The WebSocket endpoint is at `ws://<host>:3000/ws`.
The server pushes `{type, data, ts}` frames every 5s (realtime), 60s (totals), 10s (devices).
