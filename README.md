# PiMobile

> Drive your local [Pi](https://pi.dev) coding agent from your Android phone.

[中文](./README.zh-CN.md) | **English**

PiMobile is a self-hosted companion for the [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It turns your desktop Pi into a phone-remote you can drive from anywhere on your LAN or over [Tailscale](https://tailscale.com) — no SSH, no cloud.

Think “the Pi TUI, but in your pocket.”

> **Companion to [PiGate](https://github.com/MontaEllis8/pigate)** — PiGate is the browser version (React + Python). PiMobile is the native Android version (Kotlin + TypeScript). Same Pi SDK, same protocol philosophy.

---

## ✨ Features

- **Phone-first chat** — streaming text + collapsible thinking + live tool-call cards
- **File cards** — AI `write`/`edit` outputs show as downloadable cards, survives server restarts (`getHistory()` lazy recovery)
- **Session manager** — group by project, collapse, pin, instant search, auto-naming, physical delete, Fork branch indented 32dp with ↳ badge
- **Model & thinking drawer** — switch model (filtered to your actually-configured models) and 6-level thinking budget
- **Slash commands** — `/compact`, `/fork`, `/new`, `/think` with suggestions
- **WebSocket auto-reconnect** — exponential backoff + foreground service (Android 15 `dataSync` 6h-compliant)
- **Stop in 3s** — `abort` bypasses the queue, guaranteed halt
- **Zero-config LAN** + **Tailscale-ready** — same binary, `YOUR_LAN_IP:8787` or `YOUR_TAILSCALE_IP:8787`

---

## 🏗 Architecture

```
[ Android App (Kotlin/Compose) ]  ← WebSocket JSON →  [ Server (TypeScript/Node) ]  →  [ Pi SDK ]  →  [ AI API ]
       OkHttp + StateFlow + Compose          ws://host:8787/ws         SessionRegistry → PiSession
```

- **Server (3 layers)**: `server.ts` (HTTP+WS gateway, rate-limit, abort bypass) → `SessionRegistry.ts` (UUID registry, lazy 8s init, subagent noise filter) → `session.ts` (SDK event → protocol, 4KB truncation, file-card lazy recovery)
- **Android (UDF)**: `PiWebSocketClient` (OkHttp + 15s ping + backoff) → `PiRepository` (single StateFlow, `_lastStreamingMessage` slot, zero O(n) copy) → `ViewModel` (Activity-scoped) → `Compose UI`
- **Protocol**: 13 up / 13 down, fully aligned (`server/src/protocol.ts` ↔ `android/app/.../PiProtocol.kt`). See `docs/ARCHITECTURE.md`.

---

## 📁 Layout

```
pimobile/
├── server/           # TypeScript WebSocket server
│   ├── src/
│   │   ├── server.ts          # HTTP + WS + /files/:id
│   │   ├── SessionRegistry.ts # multi-session pool
│   │   ├── session.ts         # PiSession — SDK → protocol
│   │   └── protocol.ts        # 13+13 message types
│   └── test/                  # 7 integration suites
├── android/          # Kotlin/Compose app
│   └── app/src/main/java/com/pimobile/app/
│       ├── data/              # PiRepository, PiWebSocketClient, PiProtocol
│       ├── ui/chat|sessions|settings
│       └── service/PiConnectionService.kt
├── docs/ARCHITECTURE.md
└── start-server.bat  # one-click Windows start
```

---

## 🚀 Quick Start

### Prerequisites

- [Pi Coding Agent](https://pi.dev) installed and authenticated (`pi --version`, `pi --help`)
- Node.js 18+ (server) and [Android Studio](https://developer.android.com/studio) Ladybug 2024.2+ (app)
- Phone and PC on the same LAN, or both on Tailscale

### 1. Start the server

```bash
cd server
npm install
npm start          # or: npm run dev (watch)
# → PiMobile Server listening on ws://0.0.0.0:8787/ws
#   If AUTH_TOKEN is empty you will see an ERROR banner — see Security below.
```

On Windows, double-click `start-server.bat` instead.

Health check: `curl http://localhost:8787/health` → `{"status":"ok"}`

### 2. Build the Android app

```bash
cd android
./gradlew assembleDebug   # APK at android/app/build/outputs/apk/debug/app-debug.apk
# or open android/ in Android Studio → Run
```

### 3. Connect from your phone

1. Install APK on your phone / emulator (emulator uses `10.0.2.2:8787`)
2. Open PiMobile → Settings → Server Address → `YOUR_LAN_IP:8787` (e.g. `192.168.1.50:8787`, find yours with `ipconfig`)
3. If you set `AUTH_TOKEN`, fill the same token in Settings → Auth Token
4. Back to Chat — streaming starts. For remote access, use your Tailscale IP instead.

### Configuration (env)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `8787` |
| `HOST` | Bind address | `0.0.0.0` |
| `AUTH_TOKEN` | Bearer token for WS auth. If empty → **OPEN ACCESS** (LAN-only). | `""` |

Copy `.env.example` to `.env` to set them. See [SECURITY.md](SECURITY.md).

---

## 🧪 Tests

```bash
# Server — all must be green before PR
cd server
npm run typecheck               # tsc --noEmit, 0 errors
npm run lint                    # eslint, 0 issues
TEST_HOST=127.0.0.1 npm run test:integration  # 7 suites, 570+ assertions

# Android
cd android
./gradlew testDebugUnitTest     # 26 tests (PiMessageParser + PiRepository)
```

`TEST_HOST=127.0.0.1` is required (`localhost` may resolve to `::1` and be refused).

---

## 🔒 Security

PiMobile exposes a **full system agent** over the network. By default it is **OPEN ACCESS** — any LAN device can drive your agent.

Read [SECURITY.md](SECURITY.md) before exposing beyond your trusted LAN. At minimum: set `AUTH_TOKEN` and keep `8787` off the public internet; for remote use, prefer Tailscale/WireGuard over port-forwarding.

---

## 🛣 Roadmap

See [ROADMAP.md](ROADMAP.md). Highlights: image preview, rolling LRU session pool, multi-client fan-out, Room offline cache, voice input.

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📄 License

[MIT](LICENSE) — same as PiGate and `pi-coding-agent`.

---

## 🔗 Related

- [PiGate](https://github.com/MontaEllis8/pigate) — browser gateway for Pi (same team, same SDK)
- [Pi Coding Agent](https://pi.dev) — the underlying terminal agent
