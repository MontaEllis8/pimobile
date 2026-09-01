import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSession } from "./session.js";
import type { ServerMessage, SessionInfo } from "./protocol.js";

/**
 * Global registry that manages multiple PiSession instances.
 *
 * Architecture change from v2:
 *   Before: each WebSocket connection → new PiSession → dispose on disconnect
 *   After:  server startup → registry scans existing sessions
 *           ws connect → bind send callback, activate default session
 *           ws disconnect → only unbind send, sessions persist
 *           session switch → change active, old session runs in background
 *
 * Key behaviors:
 *   - Sessions survive WebSocket disconnects
 *   - Reconnection binds to the same registry
 *   - One session is "active" (foreground, receives all events)
 *   - Background sessions only listen for agent_end / error
 *   - Max 5 concurrent active AgentSessions (excess sessions sleep)
 */
export class SessionRegistry {
  /** All managed PiSession instances, keyed by session UUID (stable, unique) */
  private sessions: Map<string, PiSession> = new Map();

  /** Display names for sessions, keyed by session UUID */
  private displayNames: Map<string, string> = new Map();

  /** Parent session UUIDs, keyed by session UUID (from SDK parentSessionPath) */
  private parentIds: Map<string, string> = new Map();

  /** Currently active session UUID */
  private activeId: string | null = null;

  /** Current send callback bound to the connected WebSocket */
  private sendCallback: ((msg: ServerMessage) => void) | null = null;

  /** Working directory for all sessions */
  private cwd: string;

  /** Registered file downloads: sessionId -> (id -> absolute path).
   *  Scoped per session so that deleting a session also removes its
   *  registered files, preventing memory leaks and stale-file access. */
  private filePaths: Map<string, Map<string, string>> = new Map();

  /** Maximum number of concurrently active sessions */
  static readonly MAX_ACTIVE_SESSIONS = 5;

  /** Shared ModelRuntime singleton (QS-18).
   *  0.84.1's ModelRuntime is a heavy, explicitly-shareable object (models
   *  snapshot + credentials + provider composition). Previously every PiSession
   *  created its own on init/wakeUp — N sessions meant N duplicate builds.
   *  Lazily created on first use and injected into every PiSession. */
  private modelRuntime: ModelRuntime | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Lazily create the registry-wide shared ModelRuntime (QS-18). */
  private async getModelRuntime(): Promise<ModelRuntime> {
    if (!this.modelRuntime) {
      this.modelRuntime = await ModelRuntime.create();
    }
    return this.modelRuntime;
  }

  /**
   * Initialize the registry: discover existing sessions on disk
   * and create PiSession wrappers for them.
   */
  async init(): Promise<void> {
    // QS-18: one shared ModelRuntime for the whole registry (cold-start + wakeUp win)
    const modelRuntime = await this.getModelRuntime();

    // Scan for existing sessions across ALL project directories
    const existing = await SessionManager.listAll();
    console.log(
      `SessionRegistry: found ${existing.length} existing session(s) across all projects`
    );

    // Build path → UUID map for resolving parentSessionPath later
    const pathToId = new Map<string, string>();

    for (const s of existing) {
      try {
        const sessionCwd = s.cwd || this.cwd;
        const sm = SessionManager.open(s.path);
        const pi = this.bindSession(new PiSession(sessionCwd), modelRuntime);
        // QS-17: lazy init — metadata only, no AgentSession (cold start was
        // ~105s building one per session; the active one is pre-woken below).
        await pi.initFromSessionManager(sm, { name: s.name, firstMessage: s.firstMessage }, { lazy: true });
        // Restore real last-active time from file mtime
        try {
          const { stat } = await import("fs/promises");
          const fileStat = await stat(s.path);
          pi.setLastActiveTime(fileStat.mtimeMs);
        } catch { /* use constructor default Date.now() if stat fails */ }
        const key = pi.getSessionId();
        const display = s.name || s.firstMessage?.substring(0, 40) || s.id;
        this.sessions.set(key, pi);
        this.displayNames.set(key, display);
        pathToId.set(s.path, key);
        console.log(`  loaded: "${display}" (${key})`);
      } catch (err: any) {
        console.warn(`  skipped damaged session "${s.name || s.id}": ${err?.message || err}`);
      }
    }

    // Resolve parent session hierarchy from SDK parentSessionPath
    for (const s of existing) {
      if (s.parentSessionPath) {
        const childId = pathToId.get(s.path);
        const parentId = pathToId.get(s.parentSessionPath);
        if (childId && parentId) {
          this.parentIds.set(childId, parentId);
        }
      }
    }

    // If no sessions exist, create a default one
    if (this.sessions.size === 0) {
      await this.createSession("default");
    }

    // Activate the first session (or the most recently used)
    const firstKey = this.sessions.keys().next().value;
    if (firstKey) {
      this.activeId = firstKey;
      // QS-17: pre-initialize ONLY the active session so the first WebSocket
      // connect has a ready AgentSession (onConnect subscribes it immediately).
      // All other sessions stay lazy until activated.
      try {
        await this.sessions.get(firstKey)!.wakeUp();
      } catch (err: any) {
        console.warn(
          `SessionRegistry: failed to pre-wake active session: ${err?.message || err}`
        );
      }
    }

    // QS-01/QS-17 兜底: enforce the active limit after init. With lazy init
    // there is at most 1 live AgentSession here, so this is a cheap no-op —
    // kept as defense-in-depth for future code paths that eager-init.
    await this.enforceActiveLimit();
  }

  /**
   * Create a new session. Always creates a fresh SessionManager + PiSession;
   * does not dedupe by name (callers may end up with same-named sessions,
   * which is safe because the in-memory key is the SDK UUID, and disk
   * deletion in deleteSession() matches by id, not name).
   */
  async createSession(name: string, cwd?: string): Promise<PiSession> {
    try {
      const sessionCwd = cwd || this.cwd;

      // 跨端可见性：不传 sessionDir，SDK 按 cwd 默认归档，与 pi 终端
      // /resume 推导的目录一致（否则 app 会话归档到 server 启动目录，
      // pi 终端按自己的启动目录找 → 互不可见）。
      const sm = SessionManager.create(sessionCwd);
      sm.newSession();
      sm.appendSessionInfo(name);

      const pi = this.bindSession(new PiSession(sessionCwd), await this.getModelRuntime());
      await pi.initFromSessionManager(sm);
      const key = pi.getSessionId();
      this.sessions.set(key, pi);
      this.displayNames.set(key, name);
      await this.enforceActiveLimit();

      console.log(`SessionRegistry: created session "${name}" (${key})`);
      return pi;
    } catch (err: any) {
      throw new Error(`Failed to create session "${name}": ${err?.message || err}`);
    }
  }

  /**
   * Activate a session (switch foreground).
   * Old active session goes to background mode.
   * New active session goes to full event mode.
   *
   * (QS-09) `sessionId` (stable UUID) takes priority when provided — display
   * names are not unique, so name-based matching can switch the wrong session.
   * The name fallback stays for old clients that don't send session_id.
   */
  async activate(identifier: string, sessionId?: string): Promise<PiSession | null> {
    // QS-09: try the stable UUID first (new clients always send it)
    let target = sessionId ? this.sessions.get(sessionId) : undefined;
    let targetKey = sessionId ?? identifier;

    if (!target) {
      // Try direct UUID lookup, then display name match
      target = this.sessions.get(identifier);
      targetKey = identifier;
    }

    if (!target) {
      // Search by display name
      for (const [key, disp] of this.displayNames) {
        if (disp === identifier) {
          target = this.sessions.get(key);
          targetKey = key;
          break;
        }
      }
    }
    
    if (!target) {
      // Try to find by scanning ALL project directories
      try {
        const existing = await SessionManager.listAll();
        const found = existing.find(
          (s) => s.name === identifier || s.id === identifier
        );
        if (found) {
          const sessionCwd = found.cwd || this.cwd;
          const sm = SessionManager.open(found.path);
          target = this.bindSession(new PiSession(sessionCwd), await this.getModelRuntime());
          await target.initFromSessionManager(sm);
          targetKey = target.getSessionId();
          const display = found.name || found.firstMessage?.substring(0, 40) || found.id;
          this.sessions.set(targetKey, target);
          this.displayNames.set(targetKey, display);
          await this.enforceActiveLimit();
        } else {
          // Create new session with this identifier as display name
          target = await this.createSession(identifier);
          targetKey = target.getSessionId();
        }
      } catch (err: any) {
        console.error(`SessionRegistry: failed to activate "${identifier}": ${err?.message || err}`);
        return null;
      }
    }

    // Deactivate old active session (switch to background)
    if (this.activeId && this.activeId !== targetKey) {
      const old = this.sessions.get(this.activeId);
      if (old) {
        if (this.sendCallback) {
          old.backgroundSubscribe(this.sendCallback);
        } else {
          old.pauseEvents();
        }
      }
    }

    // Activate new session — wake from sleep if necessary
    try {
      await target.wakeUp();
    } catch (err: any) {
      console.error(
        `SessionRegistry: failed to wake "${this.displayNames.get(targetKey) || targetKey}": ${err?.message || err}`
      );
      return null;
    }
    this.activeId = targetKey;
    if (this.sendCallback) {
      target.resumeEvents(this.sendCallback);
    }
    // N6: wakeUp() may have brought a previously-sleeping session back to
    // live, which can push the active count over the limit. Enforce here
    // (not only in createSession) so activating an old sleeping session still
    // sleeps the least-recently-used non-active one. Idempotent: branches
    // above that already called enforceActiveLimit just re-check harmlessly.
    await this.enforceActiveLimit();

    const dn = this.displayNames.get(targetKey) || target.getDisplayName();
    console.log(`SessionRegistry: activated session "${dn}" (${targetKey})`);
    return target;
  }

  /**
   * Get the currently active PiSession.
   */
  getActive(): PiSession | null {
    if (!this.activeId) return null;
    return this.sessions.get(this.activeId) || null;
  }

  /** Register a file id->path, scoped to a session (called by PiSession). */
  registerFileId(sessionId: string, id: string, filePath: string): void {
    let sessionMap = this.filePaths.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.filePaths.set(sessionId, sessionMap);
    }
    sessionMap.set(id, filePath);
  }

  /** Look up a registered file path by id (used by HTTP /files/:id). */
  getFilePath(id: string): string | undefined {
    for (const sessionMap of this.filePaths.values()) {
      const path = sessionMap.get(id);
      if (path) return path;
    }
    return undefined;
  }

  /** Wire a freshly created PiSession to registry-level callbacks + the
   *  shared ModelRuntime (QS-18). */
  private bindSession(pi: PiSession, modelRuntime: ModelRuntime): PiSession {
    // P2-1: evaluate the session id LAZILY inside the closure. At bind time a
    // lazily-created PiSession has no sessionManager yet, so getSessionId()
    // returns "" — capturing it statically would dump every file into an
    // uncollectable "" bucket. By resolving at call time, registrations made
    // after wake-up land under the real stable UUID.
    pi.setFileIdRegistry((id, fp) => this.registerFileId(pi.getSessionId(), id, fp));
    pi.setModelRuntime(modelRuntime);
    return pi;
  }

  /**
   * Get a session by display name or UUID.
   */
  get(identifier: string): PiSession | null {
    const direct = this.sessions.get(identifier);
    if (direct) return direct;
    for (const [key, disp] of this.displayNames) {
      if (disp === identifier) return this.sessions.get(key) || null;
    }
    return null;
  }

  /**
   * Bind a new WebSocket connection to this registry.
   * Returns an unbind function.
   *
   * QS-14 note: duplicate-connection rejection is handled by the CALLER
   * (server.ts) using the live socket's readyState — the registry cannot see
   * the socket. Here we simply bind the new send callback; a stale connection
   * whose close event arrives later must NOT call onDisconnect() and wipe this
   * new binding (server.ts guards that via its activeWs identity check).
   *
   * On connection:
   *   1. Store the send callback
   *   2. Send full session list
   *   3. Activate the current active session with full events
   *   4. Subscribe all other background sessions (limited events)
   */
  onConnect(
    send: (msg: ServerMessage) => void
  ): () => void {
    this.sendCallback = send;

    // Send session list immediately
    this.sendSessionList(send);

    // Activate the active session with full events
    const active = this.getActive();
    if (active) {
      active.resumeEvents(send);
    }

    // Subscribe all other sessions in background mode
    for (const [key, pi] of this.sessions) {
      if (key !== this.activeId) {
        pi.backgroundSubscribe(send);
      }
    }

    // Return unbind function
    return () => {
      // N2: use the CURRENT active session (looked up at disconnect time),
      // not the one captured at connect time. The user may have switched
      // sessions in between, so pausing the stale captured `active` would
      // leave the real active session still bound to a now-dead send callback.
      // detachFromClient() also releases the send reference (unlike
      // pauseEvents, which keeps it) so background events don't fire into a
      // closed socket.
      const currentActive = this.getActive();
      if (currentActive) {
        currentActive.detachFromClient();
      }
      this.sendCallback = null;
    };
  }

  /**
   * Called when the WebSocket disconnects.
   * Sessions continue running in the background.
   */
  onDisconnect(): void {
    // N3: onConnect subscribed ALL sessions (active=full, others=background).
    // Symmetric cleanup must detach EVERY session — otherwise background
    // sessions keep dead send callbacks and keep processing events that can
    // never reach the (now-closed) client. detachFromClient() unsubscribes
    // and clears the send reference so the WebSocket can be GC'd.
    // (Previously only the current active was paused, leaking every
    // background session's send callback.)
    for (const [, pi] of this.sessions) {
      pi.detachFromClient();
    }
    this.sendCallback = null;
    console.log(
      `SessionRegistry: client disconnected (${this.sessions.size} sessions preserved)`
    );
  }

  /**
   * Delete a session by name (or stable UUID — QS-09).
   * If it's the active session, activate the next available.
   * Returns the display name of the active session after deletion,
   * or null if the identifier was not found.
   */
  async deleteSession(identifier: string, sessionId?: string): Promise<string | null> {
    // QS-09: stable UUID takes priority when provided
    let key = sessionId && this.sessions.has(sessionId) ? sessionId : null;
    if (!key) {
      // Find by UUID or display name
      key = this.sessions.has(identifier) ? identifier : null;
    }
    if (!key) {
      for (const [k, disp] of this.displayNames) {
        if (disp === identifier) { key = k; break; }
      }
    }
    if (!key) return null;

    const pi = this.sessions.get(key)!;

    // Dispose the PiSession
    pi.dispose();

    // Delete from disk (scan all projects)
    const dn = this.displayNames.get(key) || "";
    try {
      const existing = await SessionManager.listAll();
      const target = existing.find((s) => s.id === key);
      if (target && target.name === dn) {
        const fs = await import("fs/promises");
        await fs.unlink(target.path);
      } else if (target) {
        console.warn(`SessionRegistry: skipping disk delete — name mismatch for id=${key} (found "${target.name}", expected "${dn}")`);
      }
    } catch (err: any) {
      console.warn(`SessionRegistry: failed to delete session file for "${dn}": ${err?.message || err}`);
      // Continue — memory cleanup succeeded, disk cleanup is best-effort
    }

    this.sessions.delete(key);
    this.displayNames.delete(key);
    this.parentIds.delete(key);
    // Clean up registered file paths for this session
    this.filePaths.delete(key);

    // If it was the active session, activate another
    if (this.activeId === key) {
      const remaining = this.keys();
      if (remaining.length > 0) {
        await this.activate(remaining[0]);
      } else {
        // Create a new default
        await this.createSession("default");
        this.activeId = this.sessions.keys().next().value || null;
      }
    }

    console.log(`SessionRegistry: deleted session "${dn}"`);
    // Return display name of the currently active session (may have changed)
    const activeId = this.activeId;
    if (!activeId) return "";
    return this.displayNames.get(activeId)
      || this.sessions.get(activeId)?.getDisplayName()
      || activeId;
  }

  /**
   * Rename the active session.
   */
  async renameSession(oldIdentifier: string, newName: string, sessionId?: string): Promise<boolean> {
    // QS-09: stable UUID takes priority when provided
    let key = sessionId && this.sessions.has(sessionId) ? sessionId : null;
    if (!key) {
      key = this.sessions.has(oldIdentifier) ? oldIdentifier : null;
    }
    if (!key) {
      for (const [k, disp] of this.displayNames) {
        if (disp === oldIdentifier) { key = k; break; }
      }
    }
    if (!key) return false;

    const pi = this.sessions.get(key)!;
    // Validate that the old name matches current — prevents stale rename
    const currentName = this.displayNames.get(key) || pi.getDisplayName() || "";
    if (oldIdentifier !== key && oldIdentifier !== currentName && !this.sessions.has(oldIdentifier)) {
      console.warn(`SessionRegistry: rename rejected — "${oldIdentifier}" does not match current name "${currentName}"`);
      return false;
    }
    pi.setSessionName(newName);
    this.displayNames.set(key, newName);

    return true;
  }

  /**
   * Get all session names.
   */
  keys(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if the number of active sessions exceeds the limit.
   * (QS-02 fix: the loop previously `break` after sleeping ONE session, so
   * when init/createSession overshot the limit by several (e.g. 20 sessions
   * restored eager, or batch creates) only one was put to sleep and the rest
   * stayed live. Now it keeps sleeping the least-desirable non-active,
   * sleepable sessions until the count is within the limit.)
   */
  private async enforceActiveLimit(): Promise<void> {
    // N6: count actually-active (non-sleeping) sessions, not total map size.
    // Sleeping sessions remain in the map but hold no AgentSession and don't
    // consume concurrency. Counting them led to over-sleeping — e.g. 5 active
    // + 5 sleeping gave size 10 > MAX(5), forcing a 6th sleep even though only
    // 5 sessions were actually live. Count non-sleeping instead.
    let activeCount = 0;
    for (const [, pi] of this.sessions) {
      if (!pi.isSleeping()) activeCount++;
    }
    while (activeCount > SessionRegistry.MAX_ACTIVE_SESSIONS) {
      let sleptOne = false;
      for (const [key, pi] of this.sessions) {
        if (key !== this.activeId && pi.isSleepable()) {
          console.log(
            `SessionRegistry: putting "${this.displayNames.get(key) || key}" to sleep`
          );
          pi.sleep();
          activeCount--;
          sleptOne = true;
          break;
        }
      }
      // No sleepable non-active session remains — give up (active is streaming,
      // or every other session is already asleep).
      if (!sleptOne) break;
    }
  }

  /** Public: push the current session list to the client via `send`. */
  sendSessionList(send: (msg: ServerMessage) => void): void {
    const sessionList: SessionInfo[] = [];
    for (const [key, pi] of this.sessions) {
      const stats = pi.getStats();
      sessionList.push({
        session_id: key,
        name: this.displayNames.get(key) || pi.getDisplayName() || key,
        current: key === this.activeId,
        msg_count: stats.msgCount,
        project: pi.getCwd(),
        status: pi.getStatus(),
        display_name: pi.getDisplayName() || this.displayNames.get(key) || "",
        last_active: pi.getLastActiveTime(),
        parent_session: this.parentIds.get(key) || undefined,
      });
    }
    send({ type: "session_list", sessions: sessionList });
  }

  async getSessionList(): Promise<SessionInfo[]> {
    const sessionList: SessionInfo[] = [];
    for (const [key, pi] of this.sessions) {
      const stats = pi.getStats();
      sessionList.push({
        session_id: key,
        name: this.displayNames.get(key) || pi.getDisplayName() || key,
        current: key === this.activeId,
        msg_count: stats.msgCount,
        project: pi.getCwd(),
        status: pi.getStatus(),
        display_name: pi.getDisplayName() || this.displayNames.get(key) || "",
        last_active: pi.getLastActiveTime(),
        parent_session: this.parentIds.get(key) || undefined,
      });
    }
    return sessionList;
  }

  /**
   * Clean up all sessions (server shutdown).
   */
  dispose(): void {
    for (const [, pi] of this.sessions) {
      pi.dispose();
    }
    this.sessions.clear();
    this.displayNames.clear();
    this.filePaths.clear();
    this.parentIds.clear();
    this.activeId = null;
    this.sendCallback = null;
    console.log("SessionRegistry: all sessions disposed");
  }
}
