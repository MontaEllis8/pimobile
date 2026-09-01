# PiMobile

> 在 Android 手机上远程遥控你本机的 [Pi](https://pi.dev) 编程助手。

[English](./README.md) | **中文**

PiMobile 是 [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的自托管手机伴侣。把你电脑上的 Pi 变成手机可遥控的 Agent，局域网或 [Tailscale](https://tailscale.com) 秒连，无需 SSH、无需云服务。

可以理解为“装进口袋的 Pi TUI”。

> **与 [PiGate](https://github.com/MontaEllis8/pigate) 互为姊妹项目** — PiGate 是浏览器版（React + Python），PiMobile 是原生 Android 版（Kotlin + TypeScript），共用同一套 Pi SDK 与协议思想。

---

## ✨ 功能

- **手机优先的对话** — 流式正文 + 思考折叠 + 工具调用实时卡片
- **文件卡片** — AI `write`/`edit` 产出自动成卡片，重启不丢（`getHistory()` 现场扫描懒恢复）
- **会话管理** — 按项目分组折叠、置顶 Pin、即时搜索、首句自动命名、物理真删、Fork 分支 32dp 缩进 + ↳ 徽标
- **模型与思考抽屉** — 顶栏一键切换模型（仅显示你本机已配 Key 的 2~5 个可用模型）与 6 档思考深度
- **斜杠命令** — `/compact`、`/fork`、`/new`、`/think` 悬浮提示
- **WebSocket 自动重连** — 指数退避 + 前台服务保活（兼容 Android 15 `dataSync` 6h 超时）
- **3 秒必停** — `abort` 旁路分发，3s 内强制中断
- **零配置局域网 + Tailscale 直连** — 同一套 `YOUR_LAN_IP:8787` / `YOUR_TAILSCALE_IP:8787`

---

## 🏗 架构

```
[ Android App (Kotlin/Compose) ]  ← WebSocket JSON →  [ Server (TypeScript/Node) ]  →  [ Pi SDK ]  →  [ AI API ]
       OkHttp + StateFlow + Compose          ws://host:8787/ws         SessionRegistry → PiSession
```

- **Server 三层**：`server.ts`（HTTP+WS 网关、限流背压、abort 旁路）→ `SessionRegistry.ts`（UUID 会话池、惰性 8s 初始化、过滤 subagent 噪音）→ `session.ts`（SDK 事件 → 协议、4KB 截断、文件卡片懒恢复）
- **Android 单向数据流**：`PiWebSocketClient`（OkHttp + 15s ping + 退避）→ `PiRepository`（单一 StateFlow、`_lastStreamingMessage` 流式槽、零 O(n) 拷贝）→ `ViewModel`（Activity Scope）→ `Compose UI`
- **协议**：上行 13 / 下行 13，双端 100% 对齐（`server/src/protocol.ts` ↔ `android/app/.../PiProtocol.kt`），详见 `docs/ARCHITECTURE.md`

---

## 📁 目录

```
pimobile/
├── server/           # TypeScript WebSocket 服务
│   ├── src/
│   │   ├── server.ts          # HTTP + WS + /files/:id
│   │   ├── SessionRegistry.ts # 多会话池
│   │   ├── session.ts         # PiSession — SDK → 协议
│   │   └── protocol.ts        # 13+13 消息类型
│   └── test/                  # 7 套集成测试
├── android/          # Kotlin/Compose 应用
│   └── app/src/main/java/com/pimobile/app/
│       ├── data/              # PiRepository / PiWebSocketClient / PiProtocol
│       ├── ui/chat|sessions|settings
│       └── service/PiConnectionService.kt
├── docs/ARCHITECTURE.md
└── start-server.bat  # Windows 一键启动
```

---

## 🚀 快速开始

### 前置条件

- 已安装并登录 [Pi Coding Agent](https://pi.dev)（`pi --version` 可用）
- Node.js 18+（跑 server）、Android Studio Ladybug 2024.2+（编 App）
- 手机与电脑在同一局域网，或都已加入 Tailscale

### 1. 启动服务端

```bash
cd server
npm install
npm start          # 或 npm run dev（watch）
# → PiMobile Server listening on ws://0.0.0.0:8787/ws
#   若 AUTH_TOKEN 为空，会打印 ERROR 级 OPEN ACCESS 警告 — 见下方安全
```

Windows 可直接双击 `start-server.bat`。健康检查：`curl http://localhost:8787/health` → `{"status":"ok"}`

### 2. 编译 Android

```bash
cd android
./gradlew assembleDebug   # APK 在 android/app/build/outputs/apk/debug/app-debug.apk
# 或用 Android Studio 打开 android/ 直接 Run
```

### 3. 手机连接

1. 把 APK 装到真机 / 模拟器（模拟器填 `10.0.2.2:8787`）
2. 打开 PiMobile → Settings → Server Address → `YOUR_LAN_IP:8787`（如 `192.168.1.50:8787`，本机用 `ipconfig` 查）
3. 若服务端设了 `AUTH_TOKEN`，在 Settings → Auth Token 填同一 token
4. 回到 Chat 即可开始流式对话；远程用 Tailscale IP 同理

### 配置（环境变量）

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 端口 | `8787` |
| `HOST` | 绑定地址 | `0.0.0.0` |
| `AUTH_TOKEN` | WS 鉴权 Token。为空 = **开放访问**（仅限可信局域网） | `""` |

复制 `.env.example` 为 `.env` 后填入。详见 [SECURITY.md](SECURITY.md)。

---

## 🧪 测试

```bash
# Server — PR 前必须全绿
cd server
npm run typecheck               # tsc --noEmit，0 错误
npm run lint                    # eslint，0 问题
TEST_HOST=127.0.0.1 npm run test:integration  # 7 套件，570+ 断言

# Android
cd android
./gradlew testDebugUnitTest     # 26 单测（PiMessageParser + PiRepository）
```

`TEST_HOST=127.0.0.1` 必填（`localhost` 可能解析到 `::1` 被拒）。

---

## 🔒 安全

PiMobile 暴露的是**拥有完整系统权限的 Agent**。默认 **OPEN ACCESS** — 同网段任何设备都能驱动你的 Agent。

在把 `8787` 暴露到可信局域网之外前，必读 [SECURITY.md](SECURITY.md)。最小建议：设 `AUTH_TOKEN`，公网访问走 Tailscale/WireGuard，别直接端口映射。

---

## 🛣 路线图

见 [ROADMAP.md](ROADMAP.md)。亮点：图片内嵌预览、动态 LRU 会话池、多客户端扇出、Room 离线缓存、语音输入。

---

## 🤝 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 📄 许可证

[MIT](LICENSE) — 与 PiGate、`pi-coding-agent` 保持一致。

---

## 🔗 相关项目

- [PiGate](https://github.com/MontaEllis8/pigate) — Pi 的浏览器网关（同团队、同 SDK）
- [Pi Coding Agent](https://pi.dev) — 底层的终端 Agent
