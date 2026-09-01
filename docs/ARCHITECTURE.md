# Pi Mobile 架构文档（1.0 极简定稿版 · 2026-08-24）

> **冻结声明**：本文为简化评审大会（`doc/SIMPLIFICATION_MEETING.md`）最终定稿后的 1.0 架构大宪章，学生 1 天可看懂。超出本文的任何过度设计（Room 本地库、Hilt DI、KMP 跨平台、MCP 协议）均严厉封杀或延后至 1.1+。
>
> **核心定位底线**：
> > **“Pi Mobile 是一款供个人在局域网 / Tailscale 内，用手机远程遥控自己 PC 电脑端 Agent 的私有轻量工具（Personal Remote Tool），绝非多租户企业级商业 SaaS！”**

---

## 一、系统架构与数据流总览 (1.0)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Android 客户端 (Kotlin / Jetpack Compose)              │
│                                                                             │
│  ChatScreen (顶栏模型抽屉 + 思考调节) ←─ ChatViewModel ─→ PiRepository (SSOT)│
│       ↑                                      ↑             │                │
│  SessionsScreen (缩进32dp + ↳ 徽标 + 搜索/Pin) ←─ SessionsVM  │                │
│       ↑                                                    │                │
│  SettingsScreen (深浅模式 / 极简 IP 直连 / 默认 CWD)          │                │
│  SettingsDataStore (Preferences: pinnedIds / expandedGroups) │                │
│  ViewModel 生命周期: Activity Scope (跨 Tab 切换不丢失状态)  │                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ WebSocket (JSON 协议, 上行13/下行13)
                                       │ HTTP GET /files/{hex_id} (流式下载)
                                       ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Server 服务端 (TypeScript / Node.js)                   │
│                                                                             │
│  1. 网关分发层 (server.ts) ── HTTP / WS 极简直连 + 限流 + 背压 + 旁路分发   │
│      │                                                                      │
│      ├── msg dispatch → SessionRegistry (生命周期层)                        │
│      │       ├── createSession(cwd) → PiSession                             │
│      │       ├── activate(uuid)     → 懒唤醒 PiSession                      │
│      │       ├── deleteSession(id)  → fs.unlink() 物理删除                  │
│      │       └── sendSessionList()  → session_list (过滤 subagent 噪音)      │
│      └── HTTP /files/:id → hex → 50MB 限额流式传输                          │
│                                                                             │
│  2. 事件转译与懒恢复层 (session.ts) ── AgentSession (Pi SDK 0.84.1)         │
│      ├── subscribe → text_chunk (流式打字) / thinking_chunk (折叠)          │
│      ├── subscribe → tool_start / tool_output (4KB 截断保护)                │
│      ├── subscribe → file_available (write/edit 仅推卡片)                   │
│      ├── get_models → 智能过滤 (读取 PC 端 auth.json / models.json 仅下发2~5个)│
│      ├── handle(/compact) → session.compact() 一键压缩                      │
│      └── getHistory() → 现场扫描 toolCall 懒推导文件卡片 (零内存胶水)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Server 3 层职责定义

1. **`server.ts` 网关分发层**：
   - **连接管理**：默认局域网/Tailscale 零配置直连（Open Access）；保留可选环境变量 `AUTH_TOKEN` 作为防御兜底。
   - **单客户端守卫 (QS-14)**：已有 `OPEN` 连接时拒绝新连（4002）；旧连接 close 通过 `activeWs !== ws` 防误杀。
   - **限流与背压**：Token Bucket 写入限速（`RATE_BURST=5`，`REFILL=1/s`，`abort` 豁免）；1MB 背压丢弃高频 chunk 保护网络。
   - **消息旁路 (P0-1)**：`abort` 旁路 `messageChain` 串行队列，确保生成过程中 3 秒内必停。
   - **文件下载**：`GET /files/:hex` 校验 `SessionRegistry` 注册表，50MB 限额 Node 流式传输。

2. **`SessionRegistry.ts` 会话生命周期池**：
   - **UUID 路由**：严格以 SDK 稳定 UUID 作为 Map Key，彻底杜绝跨端同名覆盖。
   - **惰性加载 (QS-17)**：冷启动仅扫元数据 `lazy:true`（启动从 105s 降至 8s），`MAX_ACTIVE=5` 最旧会话自动休眠。
   - **层级管理**：从 SDK `parentSessionPath` 解析父子关联，默认不扫 `.subagents/` 目录，隔离子代理碎片噪音。

3. **`session.ts` 事件转译与懒恢复层**：
   - **事件转译**：将 SDK `AgentSession` 事件转译为 `text_chunk`、`thinking_chunk`、`message_end`。
   - **4KB 截断保护 (P0-4)**：`tool_output` 超过 4KB 强制截断，杜绝 Compose UI 卡死。
   - **产出捕获 (N7/P0-3)**：`tool_execution_start` 缓存 `args.path`，仅在 `write`/`edit` 产出文件时推送 `file_available`。
   - **零成本懒恢复 (Phase 4)**：废除内存易失的 `turnFiles` Map；在 `getHistory()` 现场扫描 JSONL 中的 `toolCall` 路径，动态推导 Hex ID 组装文件卡片，Server 重启永久不丢。
   - **模型智能过滤**：响应 `get_models` 时读取 PC 端 `~/.pi/agent/auth.json` 与 `models.json`，仅向移动端下发 2~5 个真实有 Key 的可用模型。

---

## 三、Android 单向数据流与 UI 交互 (UDF)

1. **通信与数据中心**：
   - `PiWebSocketClient`（OkHttp + 15s 心跳 + 指数退避重连 1s→60s）。
   - `PiRepository`（单一 StateFlow 中心）：`_messages` 正式列表 + `_lastStreamingMessage` 独立流式槽（QA-04 零 $O(n)$ 拷贝）。
2. **Settings 页面（3 项极简）**：
   - ① 深色/浅色模式切换；② 服务器地址直连；③ 默认工作目录 (CWD)。
   - 彻底删除手机端 API Key 配置（Key 由 PC 端统一管理）。
3. **Chat 页面交互重构**：
   - **顶栏抽屉**：点击模型胶囊拉起“模型与思考配置抽屉”，上半部分选择思考深度（`Off/Low/Med/High`），下半部分选择模型。
   - **底栏清爽**：移除误触的思考等级胶囊，保留纯粹多行自适应输入框。
   - **斜杠命令**：键入 `/` 仅展示 `/compact`, `/fork`, `/new`, `/think` 等 4~5 个核心实用白名单 Chip。
4. **Sessions 页面视觉重构**：
   - 移除生硬的 `drawBehind` 灰色 L 型树枝线，升级为子会话缩进 32dp + `↳` 分支徽标。
   - 保留长按 Rename 重命名、保留置顶 (Pin) 与顶部即时搜索 (Search)。
5. **后台保活服务**：
   - `PiConnectionService`（`dataSync` FGS 前台服务），重写 `onTimeout(6h)` 合规处理，支持无通知降级。

---

## 四、v1.0 精炼有效协议矩阵 (上行 13 种 / 下行 13 种)

> **Phase 5 冻结核验（2026-08-25）**：`server/src/protocol.ts` ↔ `PiProtocol.kt` / `PiMessageParser.kt` / `PiWebSocketClient.kt` 四文件逐一比对，**上行 13 种、下行 13 种，双端 100% 吻合，无废弃协议残留**。

| 消息类型 | 方向 | 状态 | 职责与字段 |
|---|---|---|---|
| `user_message` | C → S | 🟢 核心 | 发送用户自然语言或指令；兼作白名单斜杠命令载体 (`/compact` `/fork` `/new` `/think`) |
| `abort` | C → S | 🟢 核心 | Stop 快速中断（旁路排队，3s 必停） |
| `new_session` | C → S | 🟢 核心 | 新建会话并指定工作区 (`name?`, `cwd?`) |
| `switch_session` | C → S | 🟢 核心 | 切换会话 (`session_id` 优先 UUID 路由) |
| `delete_session` | C → S | 🟢 核心 | 物理删除磁盘 session JSONL (`session_id`) |
| `rename_session` | C → S | 🟢 核心 | 手动重命名会话 (`session_id`, `new_name`) |
| `compact` | C → S | 🟢 核心 | 主动手动触发上下文压缩 |
| `cycle_thinking` | C → S | 🟢 核心 | 调节思考深度 (`level`) |
| `set_model` | C → S | 🟡 按需 | 切换当前模型 (`provider`, `model`) |
| `get_models` | C → S | 🟡 按需 | 拉取 PC 端已配置的可用模型列表 |
| `get_sessions` | C → S | 🟢 辅助 | 主动同步全量会话列表 |
| `get_state` | C → S | 🟡 辅助 | 拉取当前会话状态快照（唤醒 sleeping 会话 / 同步 token 与思考等级） |
| `get_commands` | C → S | 🟡 辅助 | 拉取服务端命令清单（builtin 白名单 + 扩展命令） |
| `text_chunk` | S → C | 🟢 核心 | 正文文本流式打字增量 (`text`) |
| `message_end` | S → C | 🟢 核心 | 回合结束定帧（流式槽合并进消息列表） |
| `session_list` | S → C | 🟢 核心 | 全量会话元数据列表 (`sessions[]`) |
| `session_switched` | S → C | 🟢 核心 | 会话切换成功 Ack（绑定 Builder Key） |
| `message_history` | S → C | 🟢 核心 | 历史消息回放 + 懒恢复文件元数据 |
| `file_available` | S → C | 🟢 核心 | 写文件产出卡片通知 (`id`, `name`, `size`, `content_type`) |
| `thinking_chunk` | S → C | 🟡 折叠 | 思考过程流式增量（默认折叠） |
| `tool_start` / `output`| S → C | 🟡 折叠 | 工具调用状态卡片（4KB 截断保护） |
| `state_update` | S → C | 🟡 精简 | Token 消耗与 Context 使用率统计 |
| `model_list` | S → C | 🟡 过滤 | 响应 `get_models`，仅含实际有效模型 |
| `command_list` | S → C | 🟡 过滤 | 响应 `get_commands`，斜杠条数据源（客户端本地另有 4 Chip 白名单兑底） |
| `error` | S → C | 🟢 兜底 | 全局统一异常提示 (`message`) |

---

## 五、1.0 物理删除与封杀清单

- **🔴 物理删除代码与协议**：
  - `set_auth` / `auth_set`（手机配 Key 彻底拔除，电脑原生配置接管）。
  - `unreadSessionCount` / `background_complete` / `session_status`（消除状态风暴与死红点）。
  - `ask_question` / `answer_question`（解除与特定扩展的强耦合）。
  - TUI 废弃命令（`/quit`, `/login`, `/settings`, `/tree` 等彻底剔除）。
  - `server/.pi-local/` 目录（彻底物理删除 80+ 个历史遗留文件）。
  - `libs.versions.toml` 中的 `roborazzi` 构建依赖。
- **⏸️ 严厉封杀入冷宫 (1.1+ ROADMAP)**：
  - 封杀 KMP 跨平台、Hilt DI、Room 离线数据库、MCP 协议重构。
  - 图片内嵌 Coil 缩略图、语音输入、附件上传等移入 1.1+。
