# Roadmap

> Features that are planned or already shipped. PiMobile is a private remote — not a SaaS. Pick something from the list and send a PR!

## Shipped (v1.0 – 1.1.1)

- ✅ LAN / Tailscale zero-config connect (no API key on phone, PC manages creds)
- ✅ Streaming chat — `text_chunk` typewriter + `thinking_chunk` collapsible + `tool_start`/`tool_output` cards (4KB truncation)
- ✅ File cards — `file_available` push + hex `GET /files/:id` download → FileProvider → system viewer
- ✅ History lazy recovery — `getHistory()` scans JSONL `toolCall` for `write`/`edit` paths, rebuilds file cards after cold restart
- ✅ Session management — grouped by project dir (expand/collapse), pin to top, local search, auto-naming from first message, rename, physical delete via `SessionRegistry` UUID
- ✅ Fork sessions — 32dp indent + branch badge, subagent noise filtered
- ✅ Model & thinking drawer — segmented picker, smart filter (2–5 effective models), 6-level thinking budget via `/think`
- ✅ Slash commands — `/compact`, `/fork`, `/new`, `/think` (whitelist strip, command bar)
- ✅ Settings — theme (dark/light), server address, default cwd, auth token store
- ✅ WebSocket resilience — OkHttp + 15s ping + exponential backoff + foreground `dataSync` service (Android 15 6h timeout compliant)
- ✅ Protocol — 13 up / 13 down (8+5 / 7+6), four-file parity: `server/protocol.ts` ↔ `PiProtocol.kt`/`PiMessageParser.kt`/`PiWebSocketClient.kt`
- ✅ Single-client guard (QS-14), lazy session init (QS-17/18), streaming slot `_lastStreamingMessage` (QA-04)

## P1 — Next up (1.1 polish)

- **Scroll & pagination** — smooth `LazyColumn` with stable keys, history pagination for large sessions (>1k messages)
- **Image inline preview** — Coil preview for `write`'d images inside chat, tap to full-screen
- **Dynamic LRU session pool** — keep hot sessions in memory, evict cold (lazy `initFromSessionManager`)
- **Slash whitelist management** — editable whitelist in Settings, sync with `get_commands`/`command_list`
- **Background file id hardening** — randomize `/files/:id` and/or add auth header to download

## P2 — Robustness & polish

- **Path tokenization & search** —分词搜索会话（按目录/文件名 token）
- **Offline reconnect queue** — queue `user_message` while disconnected, flush on re-open
- **W10 streaming id stabilization** — stable message id per turn for `LazyColumn` key, avoid recomposition flicker
- **K2 MarkdownView large-text** — virtualize long code blocks, improve render for >10k chars
- **K6 /files auth** — enforce `Authorization` on HTTP download, client sends `Bearer` header

## P3 — Architecture

- **Multi-client fan-out** — allow 2+ phones/tablets to share one registry (currently `activeWs` single-client guard)
- **Protocol version + heartbeat** — `hello`/`ping` with version negotiation, typed `serialization` (e.g. kotlinx.serialization)
- **Contract tests** — golden-file tests that assert server ↔ Android protocol parity, run in CI
- **Hilt ban / Manual DI** — keep `AppContainer` manual DI, strictly forbid Hilt (per SIMPLIFICATION_MEETING)
- **Markdown library swap** — evaluate `multiplatform-markdown-renderer` vs current `MarkdownView`
- **Structured logging** — `pino`-style JSON logs with sessionId, redacted paths
- **Pre-approval hooks** — intercept dangerous tool calls before SDK execution (vs current post-hoc notify)

## P4 — Product stretch

- **Room offline cache** — local message/session cache for cold start without WS (currently WS-push only)
- **Attachment upload** — pick image/file on phone → upload to server cwd → inject as tool input
- **Voice input** — parity with PiGate: hold-to-talk PCM → local ASR, stream as `user_message`
- **Multi-server profiles** — save several `host:port` + token presets, quick switch
- **Advanced search** — filter sessions by model, date, token usage

## P5 — Nice to have

- **Export session** — export chat as Markdown/HTML (SDK already has `export_html`)
- **Haptic & notifications** — vibrate on send, system notification on `message_end` when backgrounded
- **PWA parity notes** — document PiGate (browser) vs PiMobile (native) feature matrix

## Out of scope (explicitly cut per SIMPLIFICATION_MEETING)

- ❌ Room/Hilt/KMP — over-engineered for a personal remote
- ❌ `set_auth`/`auth_set` on phone — PC manages all keys via `auth.json`
- ❌ Multi-tenant SaaS — PiMobile is a single-user LAN tool by design
- ❌ TUI deprecated commands / `background_complete` / `ask_question` plumbing — already slimmed
