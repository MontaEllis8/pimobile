import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { getContentType } from "./contentType.js";
import { existsSync, statSync } from "node:fs";
import { sessionLogger } from "./logger.js";
import { getFilteredModels, resolveDefaultModel } from "./modelService.js";
import { createFileHelpers } from "./fileRegistry.js";
import { createModelRuntime, createSdkSession } from "./sdkAdapter.js";
import { resolveUnifiedPath, extractBashFileTargets } from "./pathResolver.js";

interface FileMeta {
  id: string;
  name: string;
  size: number;
  content_type: string;
}

/**
 * PiSession wraps the Pi SDK AgentSession and translates SDK events
 * into the Android WebSocket protocol messages.
 */

// ── Event subscription modes ──
type SubscriptionMode = "full" | "background" | "paused";

/**
 * SDK event types handled by _subscribeInternal (E-4).
 */
const KNOWN_EVENT_TYPES = new Set<string>([
  // ── if-chain handled ──
  "agent_end",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
  "queue_update",
  "thinking_level_changed",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  // ── lifecycle markers, intentionally not forwarded ──
  "agent_start",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_end",
  // ── other valid AgentSessionEvent members ──
  "entry_appended",
  "session_info_changed",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
]);

// ── Whitelist & TUI intercept ──
const WHITELIST_COMMANDS = new Set(["compact", "fork", "new", "think"]);
const TUI_COMMANDS = new Set([
  "quit", "login", "settings", "tree", "resume", "model", "scoped-models",
  "export", "import", "share", "copy", "name", "session", "changelog",
  "hotkeys", "clone", "trust", "logout", "reload",
]);

export class PiSession {
  private session: AgentSession | null = null;
  private sessionManager: SessionManager | null = null;
  private cwd: string;

  private modelRuntime: ModelRuntime | null = null;
  private mode: SubscriptionMode = "paused";
  private sendCallback: ((msg: ServerMessage) => void) | null = null;
  private unsubscribeFn: (() => void) | null = null;
  private registerFileIdFn: ((id: string, filePath: string) => void) | null = null;

  private cachedMsgCount: number = 0;
  private cachedSessionName: string = "";
  private firstUserMessage: string = "";
  private lastActiveTime: number = Date.now();

  private cachedStatus: string = "sleeping";
  private cachedDisplayName: string = "";

  // Empty turn resilience: track if this turn produced any content
  private hadContentThisTurn: boolean = false;

  private fileHelpers!: ReturnType<typeof createFileHelpers>;

  constructor(cwd: string) {
    this.cwd = cwd;
    // re-create helpers with correct cwd (field initializer used stale this.cwd)
    this.fileHelpers = createFileHelpers(
      this.cwd,
      () => this.registerFileIdFn,
      () => this.sendCallback,
      () => this.getSessionId(),
      () => this.getName()
    );
  }

  getCwd(): string {
    return this.cwd;
  }

  setModelRuntime(mr: ModelRuntime): void {
    this.modelRuntime = mr;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await createModelRuntime();
    }
    return this.modelRuntime;
  }

  // ──────────────────────────────────────────────
  //  Initialization
  // ──────────────────────────────────────────────

  async init(): Promise<void> {
    const modelRuntime = await this.getModelRuntime();
    this.sessionManager = SessionManager.create(this.cwd);

    const { session } = await createSdkSession(this.cwd, this.sessionManager, modelRuntime);

    this.session = session;

    // Resolve default model from settings.json with fallback
    const resolved = await resolveDefaultModel(modelRuntime);
    if (resolved) {
      const defaultModel = modelRuntime.getModel(resolved.provider, resolved.model);
      if (defaultModel) {
        try {
          await session.setModel(defaultModel);
        } catch (e) {
          sessionLogger(this.getSessionId() || "unknown").warn({ err: e, provider: resolved.provider, model: resolved.model }, "setModel failed");
        }
      }
    }

    this.cachedSessionName = session.sessionName || "default";
  }

  async initFromSessionManager(sm: SessionManager, sdkInfo?: { name?: string; firstMessage?: string }, options?: { lazy?: boolean }): Promise<void> {
    this.sessionManager = sm;
    const sdkDisplay = sdkInfo?.name || sdkInfo?.firstMessage?.substring(0, 40) || "";
    this.cachedDisplayName = sdkDisplay || "";

    if (options?.lazy) {
      this.cachedSessionName = sm.getSessionName() || sdkDisplay || sm.getSessionId() || "unnamed";
      return;
    }

    const modelRuntime = await this.getModelRuntime();
    const { session } = await createSdkSession(this.cwd, sm, modelRuntime);

    this.session = session;
    this.cachedSessionName = session.sessionName || sm.getSessionName() || sdkDisplay || sm.getSessionId() || "unnamed";
  }

  // ──────────────────────────────────────────────
  //  Event subscription
  // ──────────────────────────────────────────────

  resumeEvents(send: (msg: ServerMessage) => void): void {
    this.sendCallback = send;
    this.mode = "full";
    this._subscribeInternal("full");
  }

  pauseEvents(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.mode = "paused";
  }

  detachFromClient(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.sendCallback = null;
    this.mode = "paused";
  }

  backgroundSubscribe(send: (msg: ServerMessage) => void): void {
    this.sendCallback = send;
    this.mode = "background";
    this._subscribeInternal("background");
  }

  // ──────────────────────────────────────────────
  //  Internal event subscription
  // ──────────────────────────────────────────────

  private _subscribeInternal(mode: "full" | "background"): void {
    if (!this.session) return;

    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }

    const send = this.sendCallback!;

    this.unsubscribeFn = this.session.subscribe(async (event: AgentSessionEvent) => {
      try {
        // ──────── Events sent in BOTH modes ────────
        if (event.type === "agent_end") {
          if (event.willRetry) {
            this.cachedStatus = "running";
            return;
          }

          this.cachedStatus = "completed";

          if (mode === "full") {
            send({ type: "message_end" });
            this.sendStateUpdate(send);

            // Empty turn resilience: detect 0-token empty completion / rate limit
            if (!this.hadContentThisTurn) {
              try {
                const msgs = this.session?.messages as any[] | undefined;
                let empty = true;
                if (msgs && msgs.length > 0) {
                  const last = msgs[msgs.length - 1];
                  if (last) {
                    const content = last.content;
                    if (typeof content === "string" && content.trim().length > 0) {
                      empty = false;
                    } else if (Array.isArray(content)) {
                      const hasText = content.some((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim().length > 0);
                      if (hasText) empty = false;
                    }
                  }
                }
                if (empty) {
                  sessionLogger(this.getSessionId() || this.getName()).warn("Empty turn detected — sending error frame");
                  send({ type: "error", message: "Model returned empty completion or rate limit hit. Please retry." });
                }
              } catch (e) {
                sessionLogger(this.getSessionId() || this.getName()).warn({ err: e }, "Empty turn check failed");
                send({ type: "error", message: "Model returned empty completion or rate limit hit. Please retry." });
              }
            }
            // Reset for next turn
            this.hadContentThisTurn = false;
          } else {
            // Background: no longer send background_complete / session_status (protocol slimmed)
            // Just keep status cached
          }
          return;
        }

        if (event.type === "auto_retry_start") {
          return;
        }
        if (event.type === "auto_retry_end") {
          return;
        }

        if (event.type === "compaction_start") {
          return;
        }
        if (event.type === "compaction_end") {
          if (event.errorMessage) {
            send({ type: "error", message: `Compaction failed: ${event.errorMessage}` });
          }
          this.sendStateUpdate(send);
          return;
        }

        if (event.type === "queue_update" && mode === "full") {
          return;
        }

        if (event.type === "thinking_level_changed") {
          this.sendStateUpdate(send);
          return;
        }

        // ──────── Events sent in FULL mode only ────────
        if (mode === "full") {
          if (event.type === "message_update") {
            const d = event.assistantMessageEvent;
            if (d.type === "text_delta") {
              this.hadContentThisTurn = true;
              send({ type: "text_chunk", text: d.delta });
            }
            if (d.type === "thinking_delta") {
              this.hadContentThisTurn = true;
              send({ type: "thinking_chunk", text: d.delta });
            }
            return;
          }

          if (event.type === "tool_execution_start") {
            const toolId = event.toolCallId;
            const toolName = event.toolName;
            const toolInput = JSON.stringify(event.args ?? {});

            if (toolName === "read" && event.args?.path) {
              this.fileHelpers.pendingReadPaths.set(toolId, event.args.path);
            }
            if ((toolName === "write" || toolName === "edit") && event.args?.path) {
              this.fileHelpers.pendingWriteEditPaths.set(toolId, event.args.path);
            }
            // L0+ mobile_share_image — direct original path share, reuse write/edit map (same notify path)
            if (toolName === "mobile_share_image" && event.args?.path) {
              this.fileHelpers.pendingWriteEditPaths.set(toolId, event.args.path);
            }

            this.hadContentThisTurn = true;
            send({
              type: "tool_start",
              tool_id: toolId,
              tool_name: toolName,
              input: toolInput,
            });
            return;
          }

          if (event.type === "tool_execution_update") {
            const raw =
              event.partialResult?.content?.[0]?.text ??
              event.partialResult?.text ??
              "";
            const text = this.truncateToolOutput(raw);
            this.hadContentThisTurn = true;
            send({
              type: "tool_output",
              tool_id: event.toolCallId,
              output: text,
              status: "running",
            });
            return;
          }

          if (event.type === "tool_execution_end") {
            const raw =
              event.result?.content?.[0]?.text ??
              event.result?.text ??
              "";
            const text = this.truncateToolOutput(raw);
            this.hadContentThisTurn = true;
            send({
              type: "tool_output",
              tool_id: event.toolCallId,
              output: text,
              status: event.isError ? "failed" : "completed",
            });

            if (!event.isError && (event.toolName === "write" || event.toolName === "edit")) {
              const filePath = this.fileHelpers.pendingWriteEditPaths.get(event.toolCallId);
              this.fileHelpers.pendingWriteEditPaths.delete(event.toolCallId);
              if (!filePath) {
                sessionLogger(this.getSessionId() || this.getName()).warn({ toolName: event.toolName, toolCallId: event.toolCallId, pending: this.fileHelpers.pendingWriteEditPaths.size }, "[file-notify] ended with no captured args.path — file_available may be skipped");
              }
              await this.detectAndNotifyFile(event.toolName, text, filePath);
            }
            if (!event.isError && event.toolName === "mobile_share_image") {
              const filePath = this.fileHelpers.pendingWriteEditPaths.get(event.toolCallId);
              this.fileHelpers.pendingWriteEditPaths.delete(event.toolCallId);
              if (!filePath) {
                sessionLogger(this.getSessionId() || this.getName()).warn({ toolName: event.toolName, toolCallId: event.toolCallId }, "[mobile_share] no captured args.path");
              } else {
                sessionLogger(this.getSessionId() || this.getName()).info({ filePath, toolCallId: event.toolCallId }, "[mobile_share] detected share request");
              }
              // mobile_share_image 直接发原路径，不经 write→D:/tmp 复制，复用 resolveUnifiedPath，id=hex
              await this.detectAndNotifyFile("mobile_share_image", text, filePath);
            }
            if (!event.isError && event.toolName === "read") {
              const filePath = this.fileHelpers.pendingReadPaths.get(event.toolCallId);
              if (filePath) {
                this.fileHelpers.pendingReadPaths.delete(event.toolCallId);
                await this.detectAndNotifyFile("read", "", filePath, { notify: false });
              }
            }
            // L0 fix — bash after file ops: cp / base64 pipelines produce/update files without write/edit
            // Re-trigger file_available with correct stat size (111K not 43B placeholder)
            if (!event.isError && event.toolName === "bash") {
              const rawCmd = (event as any).args?.command ?? (event as any).args?.cmd ?? "";
              const rawOutput = text;
              // try explicit file detection from bash output text (e.g. cp success) plus command parsing
              const combined = `${rawCmd}\n${rawOutput}`;
              await this.handleBashFileUpdate(combined, rawCmd);
            }
            return;
          }
        }

        if (!KNOWN_EVENT_TYPES.has(event.type)) {
          sessionLogger(this.getSessionId() || this.getName()).warn({ eventType: event.type }, "Unknown SDK event type");
        }
      } catch (err) {
        sessionLogger(this.getSessionId() || this.getName()).error({ err }, "Error in event handler");
      }
    });
  }

  // ──────────────────────────────────────────────
  //  History - lazy toolCall recovery
  // ──────────────────────────────────────────────

  getHistory(opts?: { limit?: number; offset?: number }): Array<{ role: string; text: string; thinking?: string; files?: FileMeta[]; timestamp?: number }> {
    if (!this.session) return [];
    try {
      const messages = this.session.messages;
      if (!messages || !Array.isArray(messages)) return [];

      const tsByMessage = new Map<number, number>();
      if (this.sessionManager) {
        try {
          const branch = this.sessionManager.getBranch();
          for (const entry of branch) {
            const msg = (entry as any).message;
            if (msg?.timestamp !== undefined) {
              const ms = new Date(entry.timestamp).getTime();
              if (Number.isFinite(ms)) {
                tsByMessage.set(msg.timestamp, ms);
              }
            } else if (entry.type === "custom_message" || entry.type === "branch_summary") {
              const ms = new Date(entry.timestamp).getTime();
              if (Number.isFinite(ms)) {
                tsByMessage.set(ms, ms);
              }
            }
          }
        } catch {
          // ignore
        }
      }

      const result: Array<{ role: string; text: string; thinking?: string; files?: FileMeta[]; timestamp?: number }> = [];

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as any;
        if (!m || m.role === "tool" || m.role === "toolResult") continue;

        const role = m.role || "";
        let text = "";
        let thinking = "";
        const files: FileMeta[] = [];

        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (!c) continue;
            if (c.type === "text" && c.text) {
              text += c.text;
            } else if (c.type === "thinking" && c.thinking) {
              thinking += c.thinking;
            } else if (
              (c.type === "toolCall" || c.type === "tool_use") &&
              (c.name === "write" || c.name === "edit" || c.name === "mobile_share_image")
            ) {
              const filePathStr = c.args?.path || c.parameters?.path || (c as any).arguments?.path;
              if (typeof filePathStr === "string" && filePathStr.trim().length > 0) {
                try {
                  const absPath = resolveUnifiedPath(this.cwd, filePathStr.trim(), this.getSessionId(), this.getName());
                  if (existsSync(absPath)) {
                    const fileStat = statSync(absPath);
                    if (fileStat.isFile()) {
                      const filename = absPath.split(/[\\/]/).pop() || "file";
                      const size = fileStat.size;
                      const content_type = getContentType(filename);
                      const id = Buffer.from(absPath).toString("hex");
                      this.registerFileIdFn?.(id, absPath);
                      try {
                        const alt = absPath.replace(/\\/g, "/");
                        if (alt !== absPath) this.registerFileIdFn?.(Buffer.from(alt).toString("hex"), absPath);
                      } catch {}
                      if (!files.some((f) => f.id === id)) {
                        files.push({ id, name: filename, size, content_type });
                      }
                    }
                  }
                } catch {
                  // File may have been deleted or inaccessible — skip card assembly, keep chat rendering
                }
              }
            }
          }
        }

        if (!text && !thinking && files.length === 0) continue;

        const entry: any = { role, text };
        if (thinking) entry.thinking = thinking;
        if (files.length > 0) entry.files = files;
        const ts = tsByMessage.get((m as any).timestamp);
        if (ts !== undefined) entry.timestamp = ts;
        result.push(entry);
      }

      // Pagination: limit/offset (default: all). Sliced after full scan to keep toolCall recovery intact.
      if (opts?.limit != null && opts.limit >= 0) {
        const offset = opts.offset ?? Math.max(0, result.length - opts.limit);
        // if offset not provided, take last N (most recent)
        if (opts.offset == null) {
          return result.slice(-opts.limit);
        }
        return result.slice(offset, offset + opts.limit);
      }
      return result;
    } catch {
      return [];
    }
  }

  // ──────────────────────────────────────────────
  //  Stats
  // ──────────────────────────────────────────────

  getStats(): { msgCount: number; name: string } {
    if (!this.session) {
      return { msgCount: this.cachedMsgCount, name: this.cachedSessionName };
    }
    try {
      const stats = this.session.getSessionStats();
      this.cachedMsgCount = stats.totalMessages ?? 0;
      this.cachedSessionName = this.session.sessionName || "unnamed";
    } catch {
      // Use cached values
    }
    return { msgCount: this.cachedMsgCount, name: this.cachedSessionName };
  }

  // ──────────────────────────────────────────────
  //  State update
  // ──────────────────────────────────────────────

  public requestStateUpdate(send: (msg: ServerMessage) => void): void {
    this.sendStateUpdate(send);
  }

  setFileIdRegistry(fn: (id: string, filePath: string) => void): void {
    this.registerFileIdFn = fn;
  }

  private sendStateUpdate(send: (msg: ServerMessage) => void): void {
    if (!this.session) {
      send({
        type: "state_update",
        cost: { input: 0, output: 0, total: 0 },
        context_window: 0,
        message_count: 0,
        thinking_level: "off",
      });
      return;
    }
    try {
      const stats: SessionStats = this.session.getSessionStats();
      const contextUsage = this.session.getContextUsage();
      const ctxWindow = contextUsage?.contextWindow ?? this.session.model?.contextWindow ?? 0;
      const ctxTokens = contextUsage?.tokens ?? null;
      const ctxPercent = ctxTokens != null && ctxWindow > 0 ? Math.round((ctxTokens / ctxWindow) * 100) : null;
      send({
        type: "state_update",
        cost: {
          input: stats.tokens?.input ?? 0,
          output: stats.tokens?.output ?? 0,
          total: stats.tokens?.total ?? 0,
        },
        context_window: ctxWindow,
        message_count: stats.totalMessages ?? 0,
        thinking_level: this.session.thinkingLevel,
        context_usage: ctxTokens != null && ctxPercent != null ? {
          tokens: ctxTokens,
          context_window: ctxWindow,
          percent: ctxPercent,
        } : undefined,
      });
    } catch (err) {
      sessionLogger(this.getSessionId() || this.getName()).error({ err }, "Error sending state update");
    }
  }

  // ──────────────────────────────────────────────
  //  Name
  // ──────────────────────────────────────────────

  getName(): string {
    return this.session?.sessionName || this.cachedSessionName || "default";
  }

  getDisplayName(): string {
    return this.cachedDisplayName || this.firstUserMessage || this.cachedSessionName;
  }

  getLastActiveTime(): number {
    return this.lastActiveTime;
  }

  setLastActiveTime(time: number): void {
    this.lastActiveTime = time;
  }

  getParentSessionName(): string | null {
    if (!this.session) return null;
    const header = (this.session as any).getHeader?.();
    return header?.parentSession || null;
  }

  getSessionId(): string {
    return this.sessionManager?.getSessionId() || "";
  }

  getCommandList(): Array<{ name: string; description?: string; source: string }> {
    return [
      { name: "/compact", description: "⚡ 压缩会话上下文", source: "builtin" },
      { name: "/fork", description: "🌿 从当前节点派生子会话", source: "builtin" },
      { name: "/new", description: "✨ 新建工程会话", source: "builtin" },
      { name: "/think", description: "🧠 调节思考等级 (off/low/med/high)", source: "builtin" },
    ];
  }

  setSessionName(name: string): void {
    if (this.session) {
      this.session.setSessionName(name);
    } else if (this.sessionManager) {
      try {
        this.sessionManager.appendSessionInfo(name);
      } catch (err: any) {
        sessionLogger(this.getSessionId() || "unknown").warn({ err }, "setSessionName: failed to persist session_info for sleeping session");
      }
    }
    this.cachedSessionName = name;
  }

  // ──────────────────────────────────────────────
  //  Sleep / wake (memory management)
  // ──────────────────────────────────────────────

  isSleepable(): boolean {
    return (
      !!this.session &&
      !this.session.isStreaming &&
      this.mode !== "full"
    );
  }

  isSleeping(): boolean {
    return this.session === null;
  }

  sleep(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.fileHelpers.pendingReadPaths.clear();
    this.fileHelpers.pendingWriteEditPaths.clear();
    if (this.session) {
      this.cachedSessionName = this.session.sessionName || "unnamed";
      try {
        const stats = this.session.getSessionStats();
        this.cachedMsgCount = stats.totalMessages ?? 0;
      } catch { /* ignore */ }
      this.session.dispose();
      this.session = null;
    }
    this.mode = "paused";
    this.hadContentThisTurn = false;
  }

  async wakeUp(): Promise<void> {
    if (this.session) return;
    if (!this.sessionManager) {
      throw new Error("Cannot wake: sessionManager is null (session was fully disposed)");
    }

    try {
      const modelRuntime = await this.getModelRuntime();
      const { session } = await createSdkSession(this.cwd, this.sessionManager, modelRuntime);

      this.session = session;

      if (this.sendCallback && this.mode !== "paused") {
        this._subscribeInternal(this.mode);
      }
    } catch (err) {
      sessionLogger(this.getSessionId() || this.cachedSessionName).error({ err }, `PiSession.wakeUp failed for "${this.cachedSessionName}"`);
      throw new Error(
        `Failed to wake session "${this.cachedSessionName}": ${(err as any)?.message || err}`
      );
    }
  }

  isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  getStatus(): string {
    if (!this.session) return "sleeping";
    if (this.session.isStreaming) return "running";
    if (this.mode === "full") return "active";
    if (this.cachedStatus !== "sleeping") return this.cachedStatus;
    return "completed";
  }

  // ──────────────────────────────────────────────
  //  Handle client messages
  // ──────────────────────────────────────────────

  async handle(msg: ClientMessage, send: (msg: ServerMessage) => void): Promise<void> {
    switch (msg.type) {
      case "get_commands": {
        const commands = this.getCommandList();
        send({ type: "command_list", commands });
        return;
      }
    }

    if (!this.session || !this.sessionManager) {
      send({ type: "error", message: "Session not initialized" });
      return;
    }

    try {
      switch (msg.type) {
        case "user_message": {
          const content = msg.content || "";
          const trimmed = content.trim();

          // TUI intercept: slash commands not in whitelist
          if (trimmed.startsWith("/")) {
            const rawCmd = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
            if (rawCmd.length > 0 && !WHITELIST_COMMANDS.has(rawCmd)) {
              // Friendly hint for TUI-only commands
              const isTui = TUI_COMMANDS.has(rawCmd);
              if (isTui || rawCmd.length > 0) {
                send({ type: "error", message: `提示: '/${rawCmd}' 为桌面 TUI 专用命令，手机端请在顶栏或设置页直接操作。` });
                send({ type: "message_end" });
                return;
              }
            }
            // Whitelist slash handling
            if (rawCmd === "compact") {
              await this.session.compact();
              return;
            }
            if (rawCmd === "think") {
              const parts = trimmed.split(/\s+/);
              const rawLevel = parts[1]?.toLowerCase();
              const validLevels = new Set(["off", "minimal", "low", "med", "medium", "high", "xhigh", "max"]);
              const normalize = (lvl: string): string => (lvl === "med" ? "medium" : lvl);
              const equalsNormalized = (a: string, b: string): boolean => normalize(a.toLowerCase()) === normalize(b.toLowerCase());
              if (rawLevel && validLevels.has(rawLevel)) {
                const target = normalize(rawLevel);
                const currentNorm = normalize(this.session.thinkingLevel?.toLowerCase() ?? "");
                if (currentNorm === target) {
                  this.sendStateUpdate(send);
                  return;
                }
                // Prefer direct SDK setThinkingLevel (0.84.3+, typed in 0.85.0) with normalized value — clamped to model caps
                try {
                  if (typeof this.session.setThinkingLevel === "function") {
                    this.session.setThinkingLevel(target as any);
                    // Direct set already handles alias + clamp; return immediately with effective level
                    this.sendStateUpdate(send);
                    return;
                  }
                } catch {}
                // Fallback: cycle with alias-aware matching, immediate return on success
                let attempts = 0;
                while (attempts < 6) {
                  const curNorm = normalize(this.session.thinkingLevel?.toLowerCase() ?? "");
                  if (curNorm === target) {
                    this.sendStateUpdate(send);
                    return;
                  }
                  const next = this.session.cycleThinkingLevel();
                  if (!next) break;
                  attempts++;
                  if (equalsNormalized(next, target)) {
                    this.sendStateUpdate(send);
                    return;
                  }
                }
                this.sendStateUpdate(send);
              } else {
                const newLevel = this.session.cycleThinkingLevel();
                if (newLevel) this.sendStateUpdate(send);
              }
              return;
            }
            // /fork and /new as prompt fallthrough - let model handle or just return
            if (rawCmd === "new" || rawCmd === "fork") {
              // For /new, we could hint but let it pass as prompt for now
              // Do not block — treat as normal prompt
            }
          }

          if (!this.firstUserMessage && content) {
            this.firstUserMessage = content.substring(0, 40);
          }
          this.lastActiveTime = Date.now();
          this.hadContentThisTurn = false;
          try {
            if (this.session.isStreaming) {
              await this.session.steer(content);
            } else {
              await this.session.prompt(content);
            }
          } catch (err: any) {
            sessionLogger(this.getSessionId() || this.getName()).error({ err }, "Error in prompt/steer");
            send({ type: "error", message: err?.message || "Model returned empty completion or rate limit hit. Please retry." });
            send({ type: "message_end" });
            this.hadContentThisTurn = false;
            return;
          }

          // Post-prompt empty check: if prompt resolved but no content was ever emitted (sync empty)
          // The async agent_end handler will also check, but this covers immediate empty where agent_end may have already fired
          // We schedule a microtask check to allow event loop to process agent_end
          setTimeout(() => {
            if (!this.hadContentThisTurn && !this.session?.isStreaming) {
              // Check if last message is empty
              try {
                const msgs = (this.session?.messages as any[]) || [];
                if (msgs.length > 0) {
                  const last = msgs[msgs.length - 1];
                  let hasText = false;
                  if (last) {
                    const c = last.content;
                    if (typeof c === "string" && c.trim().length > 0) hasText = true;
                    else if (Array.isArray(c)) hasText = c.some((x: any) => x?.type === "text" && x.text?.trim().length > 0);
                  }
                  if (!hasText) {
                    send({ type: "error", message: "Model returned empty completion or rate limit hit. Please retry." });
                  }
                }
              } catch {
                // ignore
              }
            }
          }, 50);
          break;
        }

        case "abort":
          await this.session.abort();
          this.hadContentThisTurn = false;
          break;

        case "compact":
          await this.session.compact();
          break;

        case "cycle_thinking": {
          const newLevel = this.session.cycleThinkingLevel();
          if (newLevel) {
            this.sendStateUpdate(send);
          }
          break;
        }

        case "set_model": {
          const model = this.session.modelRuntime.getModel(msg.provider, msg.model);
          if (model) {
            await this.session.setModel(model);
            this.sendStateUpdate(send);
          } else {
            send({
              type: "error",
              message: `Model ${msg.provider}/${msg.model} not found`,
            });
          }
          break;
        }

        case "switch_session":
        case "new_session":
        case "delete_session":
        case "rename_session":
        case "get_sessions":
          break;

        case "get_state": {
          this.sendStateUpdate(send);
          break;
        }

        case "get_models": {
          if (!this.session) break;
          try {
            const currentModel = this.session.model ? { provider: (this.session.model as any).provider || "", model: (this.session.model as any).id || "" } : null;
            const models = await getFilteredModels(this.session.modelRuntime, currentModel);
            sessionLogger(this.getSessionId() || this.getName()).info({ count: models.length, first: models.slice(0, 3).map((m: any) => m.id).join(", ") }, "get_models -> models");
            send({ type: "model_list", models });
          } catch {
            send({ type: "error", message: "Failed to get model list" });
          }
          break;
        }

        default:
          send({
            type: "error",
            message: "Unknown message type: " + (msg as { type: string }).type,
          });
          break;
      }
    } catch (err: any) {
      sessionLogger(this.getSessionId() || this.getName()).error({ err }, "Error handling message");
      send({
        type: "error",
        message: err?.message || "Internal server error",
      });
    }
  }

  // ──────────────────────────────────────────────
  //  File detection & notification
  // ──────────────────────────────────────────────

  private truncateToolOutput(text: string): string {
    const LIMIT = 4096;
    if (text.length <= LIMIT) return text;
    const kb = ((text.length - LIMIT) / 1024).toFixed(1);
    return text.slice(0, LIMIT) + `\n…[truncated ${kb} KB, full in history]`;
  }

  private async detectAndNotifyFile(toolName: string, outputText: string, explicitPath?: string, opts: { notify?: boolean } = {}): Promise<void> {
    let filePath: string | null = null;

    if (explicitPath) {
      filePath = resolveUnifiedPath(this.cwd, explicitPath, this.getSessionId(), this.getName());
    } else if (toolName === "write") {
      const match = outputText.match(/(?:wrote\s+\d+\s+bytes?\s+to\s+)(.+)$/m);
      if (match) {
        filePath = resolveUnifiedPath(this.cwd, match[1].trim(), this.getSessionId(), this.getName());
      }
    } else if (toolName === "edit") {
      const match = outputText.match(/(?:replaced\s+\d+\s+block.*?\s+in\s+)(.+)$/m);
      if (match) {
        filePath = resolveUnifiedPath(this.cwd, match[1].trim(), this.getSessionId(), this.getName());
      }
    }

    if (!filePath) {
      sessionLogger(this.getSessionId() || this.getName()).warn({ toolName, outputPreview: outputText.slice(0, 160) }, "[file-notify] produced no path");
      return;
    }

    try {
      const { stat, readFile } = await import("node:fs/promises");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;

      // Guard: placeholder write (43B) — skip notify until real binary lands via bash cp/base64
      const size = fileStat.size;
      if (size === 43) {
        try {
          const head = await readFile(filePath, "utf-8");
          if (head.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) {
            sessionLogger(this.getSessionId() || this.getName()).warn(
              { filePath, size },
              "[file-notify] placeholder detected — skip file_available, wait for bash cp/base64"
            );
            // Still register so /files/ can resolve, but do not notify with bogus size
            // Register anyway to keep id stable; size will be corrected on next bash update
            const idPlaceholder = Buffer.from(filePath).toString("hex");
            this.registerFileIdFn?.(idPlaceholder, filePath);
            try {
              const altPlace = filePath.replace(/\\/g, "/");
              if (altPlace !== filePath) this.registerFileIdFn?.(Buffer.from(altPlace).toString("hex"), filePath);
            } catch {}
            return;
          }
        } catch {}
      }

      // L0 verification: after base64 -d, ensure PNG when expected (image/*)
      // stat size must be final (111K not 43B) — already from stat
      const filename = filePath.split(/[\\/]/).pop() || "file";
      const content_type = getContentType(filename);
      const id = Buffer.from(filePath).toString("hex");

      this.registerFileIdFn?.(id, filePath);
      // Also register forward-slash variant for curl compatibility: D:/worksave/... vs D:\worksave\...
      // Task 3a expects curl with D:/worksave/10-pi/tmp/cv-real.png (2f) while resolve returns D:\... (5c).
      // Register both so either hex works, without weakening security (same underlying file).
      try {
        const altPath = filePath.replace(/\\/g, "/");
        if (altPath !== filePath) {
          const altId = Buffer.from(altPath).toString("hex");
          if (altId !== id) this.registerFileIdFn?.(altId, filePath);
        }
        const altPath2 = filePath.replace(/\//g, "\\");
        if (altPath2 !== filePath) {
          const altId2 = Buffer.from(altPath2).toString("hex");
          if (altId2 !== id) this.registerFileIdFn?.(altId2, filePath);
        }
      } catch {}

      sessionLogger(this.getSessionId() || this.getName()).info(
        { filePath, id, size, content_type },
        "[file-notify] file_available registered"
      );

      if (opts.notify === false) return;

      if (this.sendCallback) {
        this.sendCallback({
          type: "file_available",
          id,
          name: filename,
          size,
          content_type,
        });
      }
    } catch (e) {
      sessionLogger(this.getSessionId() || this.getName()).warn(
        { err: e, filePath },
        "[file-notify] stat/read failed"
      );
    }
  }

  /** L0 fix — bash cp / base64 -d pipelines: re-trigger file_available with real stat size */
  private async handleBashFileUpdate(combinedText: string, _rawCommand: string): Promise<void> {
    try {
      const candidates = extractBashFileTargets(combinedText);
      if (candidates.length === 0) return;
      // Also attempt to sync D:/tmp <-> C:/Users/.../Temp drift for /tmp paths
      const { stat, copyFile, mkdir, readFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const gitBashTmp = "C:/Users/Administrator/AppData/Local/Temp";
      for (const raw of candidates) {
        let resolved: string | null = null;
        try {
          // normalize raw for resolveUnifiedPath — strip quotes already done
          resolved = resolveUnifiedPath(this.cwd, raw, this.getSessionId(), this.getName());
        } catch {
          continue;
        }
        // If raw was a /tmp path, ensure drift copy: C:\Temp file -> D:\tmp file
        if (raw.startsWith("/tmp/")) {
          const rest = raw.slice(5);
          const winTmpPath = `${gitBashTmp}/${rest}`;
          const unifiedPath = resolved; // D:\tmp\...
          // If bash actually wrote to winTmp but unified is D:\tmp, copy over to unify
          try {
            const sWin = await stat(winTmpPath).catch(() => null);
            const sUni = await stat(unifiedPath).catch(() => null);
            if (sWin && sWin.isFile()) {
              // md5 not needed — size check + PNG header check
              const needCopy = !sUni || sWin.size !== sUni.size || sUni.size === 43;
              if (needCopy) {
                try {
                  await mkdir(dirname(unifiedPath), { recursive: true });
                  await copyFile(winTmpPath, unifiedPath);
                  sessionLogger(this.getSessionId() || this.getName()).info(
                    { winTmpPath, unifiedPath, size: sWin.size },
                    "[bash-sync] copied Git Bash /tmp -> D:/tmp unified"
                  );
                } catch (e) {
                  sessionLogger(this.getSessionId() || this.getName()).warn({ err: e, winTmpPath, unifiedPath }, "[bash-sync] copy failed");
                }
              }
            }
          } catch {}
        }
        // Now treat resolved as the file to notify (unified path)
        try {
          const st = await stat(resolved);
          if (!st.isFile()) continue;
          // Skip placeholder again
          if (st.size === 43) {
            try {
              const h = await readFile(resolved, "utf-8");
              if (h.includes("PLACEHOLDER_WILL_BE_OVERWRITTEN_WITH_BINARY")) continue;
            } catch {}
          }
          // Optional PNG validation for image paths
          const filename = resolved.split(/[\\/]/).pop() || "file";
          const content_type = getContentType(filename);
          const id = Buffer.from(resolved).toString("hex");
          this.registerFileIdFn?.(id, resolved);
          try {
            const alt = resolved.replace(/\\/g, "/");
            if (alt !== resolved) this.registerFileIdFn?.(Buffer.from(alt).toString("hex"), resolved);
          } catch {}
          if (this.sendCallback) {
            this.sendCallback({
              type: "file_available",
              id,
              name: filename,
              size: st.size,
              content_type,
            });
            sessionLogger(this.getSessionId() || this.getName()).info(
              { filePath: resolved, id, size: st.size, content_type, via: "bash" },
              "[file-notify] bash re-trigger file_available"
            );
          }
        } catch {}
      }
    } catch (e) {
      sessionLogger(this.getSessionId() || this.getName()).warn({ err: e }, "[bash-sync] handleBashFileUpdate failed");
    }
  }

  // ──────────────────────────────────────────────
  //  Cleanup
  // ──────────────────────────────────────────────

  dispose(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.fileHelpers.pendingReadPaths.clear();
    this.fileHelpers.pendingWriteEditPaths.clear();
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.sessionManager = null;
    this.sendCallback = null;
    this.mode = "paused";
    this.hadContentThisTurn = false;
  }
}
