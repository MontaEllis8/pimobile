import { createAgentSession, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { getContentType } from "./contentType.js";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

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

const FALLBACK_PROVIDER = "opencode-go";
// NOTE 2026-09-05 (SDK 0.85.0 upgrade): ox-alpha-free returns empty turns (dead free model,
// also removed from user's enabledModels) — fallback switched to deepseek-v4-flash.
const FALLBACK_MODEL = "deepseek-v4-flash";

// ── Helpers: default model resolution ──
async function resolveDefaultModel(modelRuntime: ModelRuntime): Promise<{ provider: string; model: string } | null> {
  // 1. Try reading ~/.pi/agent/settings.json defaultModel
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      if (raw) {
        const settings = JSON.parse(raw);
        const defaultModelStr: string | undefined = settings.defaultModel;
        const defaultProviderStr: string | undefined = settings.defaultProvider;
        if (typeof defaultModelStr === "string" && defaultModelStr.trim().length > 0) {
          const trimmed = defaultModelStr.trim();
          if (trimmed.includes("/")) {
            const [p, m] = trimmed.split("/", 2);
            if (p && m) {
              const candidate = modelRuntime.getModel(p, m);
              if (candidate) return { provider: p, model: m };
            }
          } else if (typeof defaultProviderStr === "string" && defaultProviderStr.trim().length > 0) {
            const candidate = modelRuntime.getModel(defaultProviderStr.trim(), trimmed);
            if (candidate) return { provider: defaultProviderStr.trim(), model: trimmed };
          } else {
            // Search any provider that has this model id
            const all = modelRuntime.getModels() as any[];
            const found = all.find((mdl: any) => (mdl.id || mdl.model) === trimmed);
            if (found) return { provider: found.provider || FALLBACK_PROVIDER, model: trimmed };
          }
        }
        // Fallback: enabledModels list
        if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
          for (const entry of settings.enabledModels) {
            if (typeof entry === "string" && entry.includes("/")) {
              const [p, m] = entry.split("/", 2);
              if (p && m) {
                const candidate = modelRuntime.getModel(p, m);
                if (candidate) return { provider: p, model: m };
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore and fallback
  }

  // 2. Fallback to first model that has a configured provider (via getAvailableSnapshot if available)
  try {
    const snap = (modelRuntime as any).getAvailableSnapshot?.() as any[] | undefined;
    if (Array.isArray(snap) && snap.length > 0) {
      const first = snap[0];
      const provider = first.provider || FALLBACK_PROVIDER;
      const model = first.id || first.model || first.name;
      if (provider && model) return { provider, model };
    }
  } catch {
    // ignore
  }

  // 3. Ultimate fallback
  const fallback = modelRuntime.getModel(FALLBACK_PROVIDER, FALLBACK_MODEL);
  if (fallback) return { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL };

  // Last resort: first from getModels
  try {
    const all = modelRuntime.getModels() as any[];
    if (all.length > 0) {
      const first = all[0];
      return { provider: first.provider || FALLBACK_PROVIDER, model: first.id || first.model || FALLBACK_MODEL };
    }
  } catch {
    // ignore
  }

  return null;
}

// ── Helpers: model filtering (1.1 polish: three-level priority) ──
async function getFilteredModels(modelRuntime: ModelRuntime, currentModel?: { provider: string; model: string } | null): Promise<Array<{ id: string; provider: string; name: string; context_window: number }>> {
  const allModels = modelRuntime.getModels() as any[];

  // ── Priority 1: enabledModels from settings.json ──
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      if (raw) {
        const settings = JSON.parse(raw);
        if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) {
          const filtered: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
          for (const entry of settings.enabledModels) {
            if (typeof entry === "string" && entry.includes("/")) {
              const [p, m] = entry.split("/", 2);
              const candidate = allModels.find((mdl: any) => mdl.provider === p && (mdl.id === m || mdl.model === m || mdl.name === m));
              if (candidate) {
                filtered.push({
                  id: candidate.id || candidate.model || candidate.name,
                  provider: candidate.provider || "",
                  name: candidate.name || candidate.id || "",
                  context_window: candidate.contextWindow ?? candidate.context_window ?? 0,
                });
              } else {
                const cand2 = modelRuntime.getModel(p, m) as any;
                if (cand2) {
                  filtered.push({
                    id: (cand2 as any).id || m,
                    provider: (cand2 as any).provider || p,
                    name: (cand2 as any).name || m,
                    context_window: (cand2 as any).contextWindow ?? 0,
                  });
                }
              }
            }
          }
          if (filtered.length > 0) {
            // If defaultModel is configured, ensure it is at the front
            if (typeof settings.defaultModel === "string" && settings.defaultModel.trim().length > 0) {
              let dmProvider: string | null = null;
              let dmId: string | null = null;
              const trimmed = settings.defaultModel.trim();
              if (trimmed.includes("/")) {
                const [p, m] = trimmed.split("/", 2);
                dmProvider = p;
                dmId = m;
              } else if (typeof settings.defaultProvider === "string" && settings.defaultProvider.trim().length > 0) {
                dmProvider = settings.defaultProvider.trim();
                dmId = trimmed;
              } else {
                const found = allModels.find((mdl: any) => mdl.id === trimmed || mdl.model === trimmed);
                if (found) {
                  dmProvider = found.provider;
                  dmId = trimmed;
                }
              }
              if (dmProvider && dmId) {
                const idx = filtered.findIndex((f) => f.provider === dmProvider && f.id === dmId);
                if (idx > 0) {
                  const [item] = filtered.splice(idx, 1);
                  filtered.unshift(item);
                } else if (idx === -1) {
                  const cand = allModels.find((mdl: any) => mdl.provider === dmProvider && (mdl.id === dmId || mdl.model === dmId));
                  if (cand) {
                    filtered.unshift({
                      id: cand.id || cand.model || dmId!,
                      provider: cand.provider || dmProvider!,
                      name: cand.name || cand.id || dmId!,
                      context_window: cand.contextWindow ?? cand.context_window ?? 0,
                    });
                  } else {
                    const cand2 = modelRuntime.getModel(dmProvider, dmId) as any;
                    if (cand2) {
                      filtered.unshift({
                        id: (cand2 as any).id || dmId!,
                        provider: (cand2 as any).provider || dmProvider!,
                        name: (cand2 as any).name || dmId!,
                        context_window: (cand2 as any).contextWindow ?? 0,
                      });
                    }
                  }
                }
              }
            }
            return filtered;
          }
        }
      }
    }
  } catch (e) {
    console.warn("[models] Failed to read settings.json:", e);
  }

  // ── Priority 2: providers with configured Key in auth.json ──
  const configuredProviders = new Set<string>();
  try {
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const raw = readFileSync(authPath, "utf-8");
      if (raw) {
        const auth = JSON.parse(raw);
        for (const [provider, entry] of Object.entries(auth)) {
          if (entry && typeof entry === "object" && (entry as any).key) {
            configuredProviders.add(provider.toLowerCase());
          }
        }
      }
    }
  } catch (e) {
    console.warn("[models] Failed to read auth.json:", e);
  }

  const usable: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
  for (const m of allModels) {
    const providerLower = (m.provider || "").toLowerCase();
    if (configuredProviders.has(providerLower)) {
      usable.push({
        id: m.id || m.model || m.name,
        provider: m.provider || "",
        name: m.name || m.id || "",
        context_window: m.contextWindow ?? m.context_window ?? 0,
      });
    }
  }

  if (usable.length >= 2) {
    return usable;
  }

  // ── Priority 3: fallback — current session model + first 3 available ──
  if (usable.length === 0 && allModels.length > 0) {
    const fallback: Array<{ id: string; provider: string; name: string; context_window: number }> = [];
    if (currentModel) {
      const cur = allModels.find((m: any) => m.provider === currentModel.provider && (m.id === currentModel.model || m.model === currentModel.model));
      if (cur) {
        fallback.push({
          id: cur.id || cur.model || cur.name,
          provider: cur.provider || "",
          name: cur.name || cur.id || "",
          context_window: cur.contextWindow ?? cur.context_window ?? 0,
        });
      }
    }
    for (const m of allModels) {
      if (fallback.length >= 3) break;
      const candidate = {
        id: m.id || m.model || m.name,
        provider: m.provider || "",
        name: m.name || m.id || "",
        context_window: m.contextWindow ?? m.context_window ?? 0,
      };
      if (!fallback.some((f) => f.id === candidate.id && f.provider === candidate.provider)) {
        fallback.push(candidate);
      }
    }
    return fallback;
  }

  return usable;
}

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

  private pendingReadPaths: Map<string, string> = new Map();
  private pendingWriteEditPaths: Map<string, string> = new Map();
  private cachedStatus: string = "sleeping";
  private cachedDisplayName: string = "";

  // Empty turn resilience: track if this turn produced any content
  private hadContentThisTurn: boolean = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  getCwd(): string {
    return this.cwd;
  }

  setModelRuntime(mr: ModelRuntime): void {
    this.modelRuntime = mr;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create();
    }
    return this.modelRuntime;
  }

  // ──────────────────────────────────────────────
  //  Initialization
  // ──────────────────────────────────────────────

  async init(): Promise<void> {
    const modelRuntime = await this.getModelRuntime();
    this.sessionManager = SessionManager.create(this.cwd);

    const { session } = await createAgentSession({
      cwd: this.cwd,
      sessionManager: this.sessionManager,
      modelRuntime,
    });

    this.session = session;

    // Resolve default model from settings.json with fallback
    const resolved = await resolveDefaultModel(modelRuntime);
    if (resolved) {
      const defaultModel = modelRuntime.getModel(resolved.provider, resolved.model);
      if (defaultModel) {
        try {
          await session.setModel(defaultModel);
        } catch (e) {
          console.warn(`[PiSession] setModel ${resolved.provider}/${resolved.model} failed:`, e);
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
    const { session } = await createAgentSession({
      cwd: this.cwd,
      sessionManager: sm,
      modelRuntime,
    });

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
                  console.warn(`[PiSession:${this.getName()}] Empty turn detected — sending error frame`);
                  send({ type: "error", message: "Model returned empty completion or rate limit hit. Please retry." });
                }
              } catch (e) {
                console.warn(`[PiSession:${this.getName()}] Empty turn check failed:`, e);
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
              this.pendingReadPaths.set(toolId, event.args.path);
            }
            if ((toolName === "write" || toolName === "edit") && event.args?.path) {
              this.pendingWriteEditPaths.set(toolId, event.args.path);
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
              const filePath = this.pendingWriteEditPaths.get(event.toolCallId);
              this.pendingWriteEditPaths.delete(event.toolCallId);
              if (!filePath) {
                console.warn(
                  `[file-notify] ${event.toolName} tool_call=${event.toolCallId} ended with no captured args.path ` +
                  `(pending=${this.pendingWriteEditPaths.size}) — file_available may be skipped. ` +
                  `output=${text.slice(0, 120)}`
                );
              }
              await this.detectAndNotifyFile(event.toolName, text, filePath);
            }
            if (!event.isError && event.toolName === "read") {
              const filePath = this.pendingReadPaths.get(event.toolCallId);
              if (filePath) {
                this.pendingReadPaths.delete(event.toolCallId);
                await this.detectAndNotifyFile("read", "", filePath, { notify: false });
              }
            }
            return;
          }
        }

        if (!KNOWN_EVENT_TYPES.has(event.type)) {
          console.warn(`[PiSession:${this.getName()}] Unknown SDK event type: ${event.type}`);
        }
      } catch (err) {
        console.error("Error in event handler:", err);
      }
    });
  }

  // ──────────────────────────────────────────────
  //  History - lazy toolCall recovery
  // ──────────────────────────────────────────────

  getHistory(): Array<{ role: string; text: string; thinking?: string; files?: FileMeta[]; timestamp?: number }> {
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
              (c.name === "write" || c.name === "edit")
            ) {
              const filePathStr = c.args?.path || c.parameters?.path || (c as any).arguments?.path;
              if (typeof filePathStr === "string" && filePathStr.trim().length > 0) {
                try {
                  const absPath = resolve(this.cwd, filePathStr.trim());
                  if (existsSync(absPath)) {
                    const fileStat = statSync(absPath);
                    if (fileStat.isFile()) {
                      const filename = absPath.split(/[\\/]/).pop() || "file";
                      const size = fileStat.size;
                      const content_type = getContentType(filename);
                      const id = Buffer.from(absPath).toString("hex");
                      this.registerFileIdFn?.(id, absPath);
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
      console.error("Error sending state update:", err);
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
        console.warn(`setSessionName: failed to persist session_info for sleeping session: ${err?.message}`);
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
    this.pendingReadPaths.clear();
    this.pendingWriteEditPaths.clear();
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
      const { session } = await createAgentSession({
        cwd: this.cwd,
        sessionManager: this.sessionManager,
        modelRuntime,
      });

      this.session = session;

      if (this.sendCallback && this.mode !== "paused") {
        this._subscribeInternal(this.mode);
      }
    } catch (err) {
      console.error(`PiSession.wakeUp failed for "${this.cachedSessionName}":`, err);
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
            console.error("Error in prompt/steer:", err);
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
            console.log(`[models] get_models -> ${models.length} models (first: ${models.slice(0, 3).map((m: any) => m.id).join(", ")})`);
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
      console.error("Error handling message:", err);
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
      const { resolve } = await import("node:path");
      filePath = resolve(this.cwd, explicitPath);
    } else if (toolName === "write") {
      const match = outputText.match(/(?:wrote\s+\d+\s+bytes?\s+to\s+)(.+)$/m);
      if (match) {
        const { resolve } = await import("node:path");
        filePath = resolve(this.cwd, match[1].trim());
      }
    } else if (toolName === "edit") {
      const match = outputText.match(/(?:replaced\s+\d+\s+block.*?\s+in\s+)(.+)$/m);
      if (match) {
        const { resolve } = await import("node:path");
        filePath = resolve(this.cwd, match[1].trim());
      }
    }

    if (!filePath) {
      console.warn(
        `[file-notify] ${toolName} produced no path (args miss + regex miss); output=${outputText.slice(0, 160)}`
      );
      return;
    }

    try {
      const { stat } = await import("node:fs/promises");
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;

      const filename = filePath.split(/[\\/]/).pop() || "file";
      const size = fileStat.size;
      const content_type = getContentType(filename);
      const id = Buffer.from(filePath).toString("hex");

      this.registerFileIdFn?.(id, filePath);

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
    } catch {
      // File may not be readable — skip
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
    this.pendingReadPaths.clear();
    this.pendingWriteEditPaths.clear();
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
