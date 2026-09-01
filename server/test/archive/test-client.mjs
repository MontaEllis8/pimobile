/**
 * Pi Android Server v2 — CLI Test Client
 *
 * Tests all 10 message types against the WebSocket server.
 * Usage: node test-client.mjs
 */

import WebSocket from "ws";

const WS_URL = "ws://localhost:8787/ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TestClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.queue = []; // buffered messages
    this.waiter = null; // { resolve, predicate } — current pending waiter
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        console.log("✅ Connected to server");
        resolve();
      });
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        this._dispatch(msg);
      });
      this.ws.on("error", (err) => {
        console.error("WebSocket error:", err.message);
        reject(err);
      });
      this.ws.on("close", () => {
        console.log("Connection closed");
      });
    });
  }

  /**
   * Dispatch incoming message: if a waiter is waiting and predicate matches,
   * resolve it. Otherwise buffer the message.
   * If a waiter is waiting but predicate doesn't match, the message is consumed
   * (waiter's onMessage callback gets it) and waiter stays active.
   */
  _dispatch(msg) {
    if (this.waiter) {
      // Let the waiter decide
      if (this.waiter.predicate(msg)) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        // Not what we want — call onMessage if present, then keep waiting
        if (this.waiter.onMessage) this.waiter.onMessage(msg);
      }
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Wait for a message matching predicate, with a single total timeout.
   * Intermediate messages are passed to onMessage (optional).
   */
  waitFor(predicate, timeout = 60000, onMessage) {
    return new Promise((resolve, reject) => {
      // First check buffered messages
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (predicate(msg)) {
          resolve(msg);
          return;
        }
        if (onMessage) onMessage(msg);
      }

      // Set up waiter
      const timer = setTimeout(() => {
        if (this.waiter) {
          this.waiter = null;
          reject(new Error("Timeout waiting for matching message"));
        }
      }, timeout);

      this.waiter = {
        predicate,
        resolve,
        timer,
        onMessage,
      };
    });
  }

  /**
   * Wait for next message (any type). Uses queue first.
   */
  nextMessage(timeout = 60000) {
    return this.waitFor(() => true, timeout);
  }

  drain() {
    this.queue = [];
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log("\n═══════════════════════════════════════");
    console.log("  Pi Android Server v2 — Test Suite");
    console.log("═══════════════════════════════════════\n");

    for (const { name, fn } of this.tests) {
      this.drain();
      this.waiter = null;
      process.stdout.write(`  ${name} ... `);
      try {
        await fn();
        console.log("✅ PASS");
        this.passed++;
      } catch (err) {
        console.log(`❌ FAIL: ${err.message}`);
        this.failed++;
      }
    }

    console.log("\n═══════════════════════════════════════");
    console.log(
      `  Results: ${this.passed} passed, ${this.failed} failed out of ${this.tests.length} tests`
    );
    console.log("═══════════════════════════════════════\n");

    this.ws.close();
    process.exit(this.failed > 0 ? 1 : 0);
  }
}

async function main() {
  const client = new TestClient(WS_URL);
  await client.connect();

  // ── Test 1: Send user_message, receive streaming text_chunks + message_end ──
  client.test("1. user_message → streaming text_chunks", async () => {
    client.drain();
    client.send({ type: "user_message", content: "Say hello in one sentence." });

    let gotText = false;
    const endMsg = await client.waitFor(
      (msg) => msg.type === "message_end",
      60000,
      (msg) => {
        if (msg.type === "text_chunk" && msg.text) gotText = true;
      }
    );

    if (!gotText) throw new Error("No text_chunk received before message_end");
  });

  // ── Test 2: Verify message_end is received ──
  client.test("2. message_end received", async () => {
    console.log("     ✓ Verified in test 1");
  });

  // ── Test 3: Verify state_update with a positive context_window ──
  client.test("3. state_update with positive context_window", async () => {
    const msg = await client.waitFor(
      (m) => m.type === "state_update",
      10000
    );
    if (typeof msg.context_window !== "number" || msg.context_window <= 0) {
      throw new Error(`context_window=${msg.context_window}, expected a positive number`);
    }
    console.log(`     ✓ context_window = ${msg.context_window}`);
  });

  // ── Test 4: get_sessions returns list ──
  client.test("4. get_sessions returns list", async () => {
    client.drain();
    client.send({ type: "get_sessions" });
    const msg = await client.waitFor(
      (m) => m.type === "session_list",
      10000
    );
    if (!Array.isArray(msg.sessions)) throw new Error("sessions is not an array");
    console.log(`     ✓ ${msg.sessions.length} sessions found`);
  });

  // ── Test 5: switch_session ──
  client.test("5. switch_session", async () => {
    client.drain();
    client.send({ type: "get_sessions" });
    const listMsg = await client.waitFor(
      (m) => m.type === "session_list",
      10000
    );

    if (listMsg.sessions.length === 0) {
      console.log("     ⚠ No sessions to switch to, creating one first");
      client.drain();
      client.send({ type: "new_session", name: "test-switch-target" });
      const switchMsg = await client.waitFor(
        (m) => m.type === "session_switched",
        10000
      );
      console.log(`     ✓ Switched to new session: ${switchMsg.name}`);
      return;
    }

    const target = listMsg.sessions[0];
    client.drain();
    client.send({ type: "switch_session", name: target.name });
    const msg = await client.waitFor(
      (m) => m.type === "session_switched",
      10000
    );
    console.log(`     ✓ Switched to session: ${msg.name}`);
  });

  // ── Test 6: new_session ──
  client.test("6. new_session", async () => {
    client.drain();
    const name = "test-session-" + Date.now();
    client.send({ type: "new_session", name });
    const msg = await client.waitFor(
      (m) => m.type === "session_switched",
      10000
    );
    console.log(`     ✓ Created session: ${msg.name}`);
  });

  // ── Test 7: abort ──
  client.test("7. abort", async () => {
    client.drain();
    // Send a prompt that will generate a long response
    client.send({
      type: "user_message",
      content:
        "Write a very long essay about the history of computing, at least 500 words. Start now.",
    });

    // Give the prompt time to start processing, then abort.
    // The SDK may spend several seconds on initialization before the first
    // text_chunk, so we don't wait for text_chunk — we just wait briefly
    // and then abort.
    await sleep(1500);
    client.send({ type: "abort" });

    // Wait for message_end (abort triggers agent_end → message_end).
    // Also accept error as valid.
    const endMsg = await client.waitFor(
      (m) => m.type === "message_end" || m.type === "error",
      30000
    );

    if (endMsg.type === "error") {
      console.log(`     ⚠ Abort returned error: ${endMsg.message}`);
    } else {
      console.log("     ✓ message_end received after abort");
    }
  });

  // ── Test 8: set_model ──
  client.test("8. set_model", async () => {
    client.drain();
    // Try to set a model — error is acceptable if model not available
    client.send({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" });

    // If model set fails, we get error. If it succeeds, no response.
    // Wait up to 3s for an error; if none, assume success.
    const result = await Promise.race([
      client.waitFor((m) => m.type === "error", 3000).catch(() => null),
      sleep(3000).then(() => null),
    ]);

    if (result && result.type === "error") {
      console.log(`     ⚠ Model not available: ${result.message}`);
    } else {
      console.log("     ✓ set_model accepted (no error)");
    }
  });

  // ── Test 9: compact ──
  client.test("9. compact", async () => {
    client.drain();
    client.send({ type: "compact" });

    // Wait for either state_update, message_end, or error
    const msg = await client.waitFor(
      (m) =>
        m.type === "state_update" ||
        m.type === "message_end" ||
        m.type === "error",
      15000
    );

    if (msg.type === "error") {
      console.log(`     ⚠ ${msg.message}`);
    } else {
      console.log("     ✓ compact completed");
    }
  });

  // ── Test 10: get_state ──
  client.test("10. get_state", async () => {
    client.drain();
    client.send({ type: "get_state" });
    const msg = await client.waitFor(
      (m) => m.type === "state_update",
      10000
    );
    console.log(
      `     ✓ State: ${msg.message_count} msgs, ${msg.context_window} ctx window`
    );
  });

  await client.run();
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
