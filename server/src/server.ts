import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { SessionRegistry } from "./SessionRegistry.js";
import { config } from "./config.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { getContentType } from "./contentType.js";

/**
 * Start the WebSocket server for the Pi Android backend.
 *
 * v3 CHANGES (from v2):
 *   - SessionRegistry manages ALL PiSessions globally (not per-connection).
 *   - Sessions survive WebSocket disconnects.
 *   - Reconnection binds to the same registry and restores the active session.
 *   - Session switching does NOT destroy old sessions — they run in background.
 */
export async function startServer(): Promise<void> {
  // ── Session Registry (global, survives connections) ──
  const cwd = process.cwd();
  const registry = new SessionRegistry(cwd);
  await registry.init();

  // ── HTTP server for health checks and file endpoints ──
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.url === "/health") {
      applyCors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // File download endpoint
    if (req.url?.startsWith("/files/")) {
      handleFileDownload(req, res, registry);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  // QS-14: identity of the currently-accepted WebSocket. Single-client design —
  // the registry keeps ONE sendCallback, so a second live connection would
  // steal events from the first. Guarded by readyState: only reject while the
  // previous socket is truly OPEN; a CLOSING/CLOSED socket (fast reconnect)
  // hands over cleanly instead.
  let activeWs: WebSocket | null = null;

  console.log(`Pi Android Server v3 listening on ws://${config.host}:${config.port}/ws`);
  if (!config.authToken) {
    // P0-6 S1: open-access must be unmissable in logs (ERROR level per FIX-PLAN)
    console.error("⚠️  AUTH_TOKEN is empty — server is in OPEN ACCESS mode. Any device on LAN can control this agent!");
    console.error("⚠️  Set AUTH_TOKEN env var before any use beyond personal LAN. See README → Security.");
  }
  console.log(`Auth token: ${config.authToken ? "configured" : "none (open access)"}`);
  console.log(`Sessions: ${registry.keys().length} loaded`);

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    try {
      // ── Authentication ──
      // QS-13: prefer Authorization: Bearer <token> header; keep query-param
      // fallback for old clients (a token in the URL leaks into access logs
      // and can't be rotated per-connection).
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );
      const authHeader = req.headers.authorization;
      const headerToken =
        authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
      const token = headerToken ?? url.searchParams.get("token");
      if (config.authToken && token !== config.authToken) {
        console.warn(
          `Unauthorized connection attempt from ${req.socket.remoteAddress}`
        );
        ws.close(4001, "Unauthorized");
        return;
      }

      // QS-14: reject a newcomer only while another socket is still OPEN.
      // (Do NOT kick the old connection — ws.close() is async; its late close
      // handler would call onDisconnect() and wipe the new binding. Rejecting
      // the newcomer is the safe move.)
      if (activeWs && activeWs !== ws && activeWs.readyState === WebSocket.OPEN) {
        console.warn(
          `Rejecting duplicate connection from ${req.socket.remoteAddress} (single-client)`
        );
        ws.close(4002, "Already connected");
        return;
      }
      activeWs = ws;

      console.log(`Android connected from ${req.socket.remoteAddress}`);

      // ── Per-connection rate limiter (token bucket) ──
      const RATE_BURST = 5;
      const RATE_REFILL = 1; // tokens per second
      let rateTokens = RATE_BURST;
      let rateLastRefill = Date.now();

      const checkRateLimit = (): boolean => {
        const now = Date.now();
        const elapsed = (now - rateLastRefill) / 1000;
        rateTokens = Math.min(RATE_BURST, rateTokens + elapsed * RATE_REFILL);
        rateLastRefill = now;
        if (rateTokens < 1) return false;
        rateTokens -= 1;
        return true;
      };

      // N14/QS-04: write operations subject to rate limiting. Read operations
      // (get_sessions/get_state/get_models/get_commands) and session navigation
      // (switch_session) are unlimited. abort is exempt — it is a
      // user-initiated interrupt that must never be delayed.
      const RATE_LIMITED_TYPES = new Set([
        "user_message",
        "new_session",
        "delete_session",
        "rename_session",
        "set_model",
        "compact",
      ]);

      // ── WebSocket send helper ──
      // QS-12: backpressure — drop high-frequency streaming frames when the
      // client can't keep up (bufferedAmount > 1MB) instead of letting the
      // buffer grow unbounded. Terminal frames (message_end/error) always go
      // through so the UI never hangs mid-generation.
      let droppedChunkFrames = 0;
      const wsSend = (msg: ServerMessage) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (
          (msg.type === "text_chunk" || msg.type === "thinking_chunk") &&
          (ws as any).bufferedAmount > 1 * 1024 * 1024
        ) {
          droppedChunkFrames++;
          if (droppedChunkFrames % 100 === 1) {
            console.warn(
              `wsSend: dropping stream chunk (buffered ${(ws as any).bufferedAmount} bytes, dropped so far: ${droppedChunkFrames})`
            );
          }
          return;
        }
        ws.send(JSON.stringify(msg));
      };

      // ── Bind connection to registry ──
      // This sends session_list, activates the active session (full events),
      // and subscribes all other sessions in background mode.
      // (QS-14 duplicate-rejection already handled above via activeWs.)
      const unbind = registry.onConnect(wsSend);

      // ── Send history for the active session ──
      const active = registry.getActive();
      if (active) {
        // Send available commands (builtin + extension)
        const cmds = active.getCommandList();
        if (cmds.length > 0) {
          wsSend({ type: "command_list", commands: cmds });
        }

        const history = active.getHistory();
        if (history && history.length > 0) {
          wsSend({
            type: "message_history",
            name: active.getName(),
            messages: history,
          });
        }
      }

      // ── Receive Android messages ──
      // N10: per-connection message queue. ws "message" events fire
      // concurrently and each previously ran an independent async handler —
      // two switch_session messages arriving back-to-back could interleave
      // their await points (activate→wakeUp is async), double-wakeUp and
      // double-setActiveId, briefly leaving two sessions in full event mode.
      // Serializing via a promise chain guarantees one message fully completes
      // before the next starts processing. No new dependency (vs p-queue).
      let messageChain: Promise<void> = Promise.resolve();

      const processMessage = async (msg: ClientMessage): Promise<void> => {
        // Rate-limit write operations to prevent abuse (N14/QS-04: see
        // RATE_LIMITED_TYPES above for scope and exemptions)
        if (RATE_LIMITED_TYPES.has(msg.type) && !checkRateLimit()) {
          wsSend({ type: "error", message: "Rate limit exceeded. Please wait before sending another message." });
          return;
        }

        // Handle session-level messages at the registry level
        switch (msg.type) {
          case "switch_session": {
            // QS-09: prefer the stable session_id when the client sends it
            const activated = await registry.activate(msg.name, msg.session_id);
            if (activated) {
              wsSend({
                type: "session_switched",
                name: msg.name,
                session_id: activated.getSessionId(),
              });
              // Send history for the newly activated session
              const hist = activated.getHistory();
              if (hist && hist.length > 0) {
                wsSend({
                  type: "message_history",
                  name: msg.name,
                  messages: hist,
                });
              }
              // Sync state (thinking_level, tokens, etc.)
              activated.requestStateUpdate(wsSend);
            } else {
              wsSend({
                type: "error",
                message: `Failed to activate session "${msg.name}"`,
              });
            }
            return;
          }

          case "new_session": {
            const name = msg.name || `session-${Date.now()}`;
            const created = await registry.createSession(name, msg.cwd);
            await registry.activate(created.getSessionId());
            registry.sendSessionList(wsSend);
            wsSend({
              type: "session_switched",
              name,
              session_id: created.getSessionId(),
            });
            // Sync state directly via created instance (avoid getActive race on duplicate names)
            created.requestStateUpdate(wsSend);
            return;
          }

          case "delete_session": {
            const newName = await registry.deleteSession(msg.name, msg.session_id);
            if (newName !== null) {
              registry.sendSessionList(wsSend);
              const activeAfter = registry.getActive();
              wsSend({
                type: "session_switched",
                name: newName,
                session_id: activeAfter?.getSessionId(),
              });
              // Sync history + state for the now-active session
              const active = registry.getActive();
              if (active) {
                const hist = active.getHistory();
                if (hist && hist.length > 0) {
                  wsSend({
                    type: "message_history",
                    name: newName,
                    messages: hist,
                  });
                }
                active.requestStateUpdate(wsSend);
              }
            } else {
              wsSend({
                type: "error",
                message: `Session "${msg.name}" not found`,
              });
            }
            return;
          }

          case "rename_session": {
            // N4: capture the active session BEFORE renaming so we can tell
            // whether the rename targeted the currently-active session.
            // Renaming a background session must only refresh the sidebar
            // (session_list); sending session_switched would yank the user's
            // chat view/history to a different session.
            const activeBefore = registry.getActive();
            const activeId = activeBefore?.getSessionId() ?? "";
            const activeName =
              activeBefore?.getDisplayName() ?? activeBefore?.getName() ?? "";
            const ok = await registry.renameSession(msg.old, msg.new, msg.session_id);
            if (ok) {
              registry.sendSessionList(wsSend);
              // QS-09: renamed session keeps its stable UUID — match by id
              if (msg.old === activeId || msg.old === activeName) {
                wsSend({
                  type: "session_switched",
                  name: msg.new,
                  session_id: activeId,
                });
              }
            } else {
              wsSend({
                type: "error",
                message: `Failed to rename session "${msg.old}": session not found or name mismatch`,
              });
            }
            return;
          }

          case "get_sessions": {
            const list = await registry.getSessionList();
            wsSend({ type: "session_list", sessions: list });
            return;
          }
        }

        // Route other messages to the active session
        const activeSession = registry.getActive();
        if (activeSession) {
          await activeSession.handle(msg, wsSend);
        } else {
          wsSend({
            type: "error",
            message: "No active session",
          });
        }
      };

      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Parse outside the chain so a malformed frame is rejected immediately
        // without blocking the queue or being silently swallowed by the
        // chain's catch (which would mask the parse error as a handler error).
        let msg: ClientMessage;
        try {
          const text = data.toString();
          msg = JSON.parse(text);
        } catch (err: any) {
          console.error("Error parsing message:", err);
          if (ws.readyState === WebSocket.OPEN) {
            wsSend({
              type: "error",
              message: "Invalid JSON: " + (err?.message || "parse error"),
            });
          }
          return;
        }
        // P0-1 A1 fix: abort bypasses messageChain — prompt() blocks the chain for entire turn
        if (msg.type === "abort") {
          processMessage(msg).catch((err: any) => {
            console.error("Error processing message:", err);
            if (ws.readyState === WebSocket.OPEN) {
              wsSend({
                type: "error",
                message: err?.message || "Failed to process message",
              });
            }
          });
          return;
        }
        // Serialize: chain each message onto the previous so two rapid
        // switch_session messages can't interleave their async work.
        messageChain = messageChain
          .then(() => processMessage(msg))
          .catch((err: any) => {
            console.error("Error processing message:", err);
            if (ws.readyState === WebSocket.OPEN) {
              wsSend({
                type: "error",
                message: err?.message || "Failed to process message",
              });
            }
          });
      });

      // ── Handle disconnect ──
      // v3: only unbind the send callback, sessions continue running
      // QS-15: close + error can both fire for the same socket — guard with a
      // flag so cleanup (unbind/onDisconnect) runs exactly once. Idempotent
      // before, but double-running it would log twice and re-trigger session
      // detach for every session.
      let disconnected = false;
      const handleDisconnect = (reason: string) => {
        if (disconnected) return;
        disconnected = true;
        // QS-14: only the CURRENT active socket may tear down the registry
        // binding. A stale (replaced) connection's late close event must not
        // call onDisconnect() — it would wipe the new connection's sendCallback
        // and every event would go nowhere.
        if (activeWs !== ws) {
          console.log(`Stale connection closed (${reason}, already replaced)`);
          return;
        }
        activeWs = null;
        unbind();
        registry.onDisconnect();
        console.log(`Android disconnected (${reason}, sessions preserved)`);
      };
      ws.on("close", () => handleDisconnect("close"));
      ws.on("error", (err: Error) => {
        console.error("WebSocket error:", err);
        handleDisconnect("error");
      });
    } catch (err) {
      console.error("Failed to initialize session:", err);
      ws.close(1011, "Internal server error");
    }
  });

  wss.on("error", (err: Error) => {
    console.error("WebSocket server error:", err);
  });

  // ── Graceful shutdown ──
  const shutdown = () => {
    console.log("\nShutting down server...");
    registry.dispose();
    wss.close();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start listening
  httpServer.listen(config.port, config.host);
  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n❌ Port ${config.port} is already in use.`);
      console.error(`   Run: npx kill-port ${config.port}`);
      console.error(`   Or check: netstat -ano | findstr :${config.port}\n`);
    }
    throw err;
  });
}

/**
 * Set CORS headers shared across all HTTP responses.
 */
function applyCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

/**
 * Handle file download requests.
 * GET /files/:id — serve the file content.
 */
async function handleFileDownload(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry
): Promise<void> {
  applyCors(res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const encoded = req.url!.replace("/files/", "").split("?")[0];
    // Only serve files the server itself registered (emitted via file_available).
    // Look up the original path from the registry; never decode an arbitrary id,
    // so a guessed hex id cannot read files the AI never touched.
    const filePath = registry.getFilePath(encoded);
    if (!filePath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File not registered" }));
      return;
    }
    const fs = await import("fs/promises");
    const path = await import("path");

    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);

    // QS-03: refuse oversized files up-front (registered size is known; a
    // 50MB cap keeps the HTTP path from ever buffering huge artifacts).
    // 413 = Payload Too Large.
    if (stat.size > 50 * 1024 * 1024) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File too large" }));
      return;
    }

    const filename = path.basename(resolved);
    const contentType = getContentType(filename);
    const isRenderable = contentType.startsWith("text/html") || contentType.startsWith("image/");
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": isRenderable
        ? "inline"
        : `attachment; filename="${encodeURIComponent(filename)}"`,
      "Content-Length": String(stat.size),
      // QS-03: files are immutable per id (id = hex of absolute path) — a
      // short private cache is safe and avoids re-reading on repeat taps.
      "Cache-Control": "private, max-age=60",
    });

    // QS-03: stream instead of readFile — never hold the whole file in memory.
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(resolved);
    stream.pipe(res);
    stream.on("error", () => res.destroy());
  } catch (err: any) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File not found" }));
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
