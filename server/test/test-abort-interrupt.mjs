/**
 * P0-1 A1 Regression Test: abort must interrupt generation immediately.
 *
 * Background (2026-08-23 incident): server.ts serialized ALL WebSocket messages
 * through messageChain while session.prompt() blocks until turn end — so an
 * abort queued behind a generating user_message could never run (283 chunks /
 * 17.4s continued after abort was issued). Fix: abort/answer_question bypass
 * the chain (direct processMessage call).
 *
 * THE LESSON THIS FILE ENFORCES: the old abort test only SENT abort without
 * ASSERTING the stream stopped. This file asserts:
 *   1. message_end arrives after abort
 *   2. within ≤3s of abort
 *   3. (nearly) no text_chunk frames arrive after abort (≤2 in-flight slack)
 *
 * Usage: server must be running (npm run start or npx tsx src/index.ts)
 *   node test-abort-interrupt.mjs
 * Env: TEST_HOST / TEST_PORT override 127.0.0.1:8787
 *
 * Note: makes ONE real model call (streaming generation) — kept last in the
 * test:integration chain so cheap suites fail fast before it runs.
 */
import WebSocket from "ws";

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || 8787;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

const ABORT_DELAY_MS = 2000;      // abort scheduled N ms after first chunk
const STOP_LATENCY_LIMIT_MS = 3000; // plan requirement: stream stops ≤3s
const CHUNK_SLACK_AFTER_ABORT = 2;  // tolerate in-flight frames around abort
const WATCHDOG_MS = 45000;

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}

async function connectWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const wsTmp = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => { if (settled) return; settled = true; cleanup(); resolve({ ok: true, ws: wsTmp }); };
      const onClose = (code) => { if (settled) return; if (code === 4002) { settled = true; cleanup(); try { wsTmp.close(); } catch {} resolve({ ok: false, code }); } };
      const onError = () => {};
      const cleanup = () => { wsTmp.off("open", onOpen); wsTmp.off("close", onClose); wsTmp.off("error", onError); };
      wsTmp.on("open", onOpen); wsTmp.on("close", onClose); wsTmp.on("error", onError);
      setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ ok: false, code: 0 }); }, 5000);
    });
    if (result.ok && result.ws) { if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`); return result.ws; }
    if (result.code === 4002 && attempt < maxRetries) { const delay = 500 + Math.random() * 1000; console.log(`  ⚠️  收到 4002 — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`); await new Promise(r => setTimeout(r, delay)); continue; }
    throw new Error(`WebSocket connect failed after ${maxRetries} attempts (code=${result.code})`);
  }
  throw new Error("connectWithRetry exhausted");
}

const ws = await connectWithRetry(3);

const state = {
  sessionId: null,
  totalChunks: 0,
  chunksAfterAbort: 0,
  abortSentAt: null,
  endAfterAbortAt: null,
  endBeforeAbortAt: null,
};

ws.on("message", (d) => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }

  if (m.type === "session_switched" && m.name === "abort-interrupt-test") {
    state.sessionId = m.session_id;
    ws.send(JSON.stringify({
      type: "user_message",
      content: "请从 1 数到 500，每行输出一个数字，格式严格为「第N个：N」，不要省略任何数字，不要添加其他说明。",
    }));
    return;
  }
  if (m.type === "text_chunk") {
    state.totalChunks++;
    // First chunk: schedule the abort (once)
    if (state.totalChunks === 3) {
      setTimeout(() => {
        state.abortSentAt = Date.now();
        ws.send(JSON.stringify({ type: "abort" }));
        console.log(`  … abort sent (+${((state.abortSentAt - t0) / 1000).toFixed(1)}s)`);
      }, ABORT_DELAY_MS);
    }
    if (state.abortSentAt && Date.now() >= state.abortSentAt) state.chunksAfterAbort++;
    return;
  }
  if (m.type === "message_end") {
    if (state.abortSentAt) {
      if (!state.endAfterAbortAt) state.endAfterAbortAt = Date.now();
    } else {
      state.endBeforeAbortAt = Date.now(); // natural finish BEFORE abort → task too small
    }
    return;
  }
});

let cleanupDone = false;
async function cleanup() {
  if (cleanupDone || !state.sessionId) return;
  cleanupDone = true;
  try {
    ws.send(JSON.stringify({
      type: "delete_session",
      name: "abort-interrupt-test",
      session_id: state.sessionId,
    }));
  } catch {}
}

console.log("\n🧪 Abort Interrupt Regression Test (P0-1 A1)\n");
const t0 = Date.now();

try {
  // ws already connected via retry
  ws.send(JSON.stringify({ type: "new_session", name: "abort-interrupt-test" }));

  // Watchdog: overall budget
  const verdict = await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (state.endAfterAbortAt) { clearInterval(tick); resolve(true); }
      else if (Date.now() - t0 > WATCHDOG_MS) { clearInterval(tick); resolve(false); }
    }, 250);
  });

  if (!verdict) {
    test("收到 message_end（abort 后）", false,
      `watchdog ${WATCHDOG_MS}ms 超时：totalChunks=${state.totalChunks} endAfterAbort=${!!state.endAfterAbortAt}`);
  } else {
    const stopLatency = state.endAfterAbortAt - state.abortSentAt;

    test("生成已启动（收到流式 chunk）", state.totalChunks > 3,
      `totalChunks=${state.totalChunks}`);
    test("收到 message_end（abort 后）", state.endAfterAbortAt !== null,
      `endAfterAbort=${state.endAfterAbortAt}`);
    test(`停止延迟 ≤${STOP_LATENCY_LIMIT_MS / 1000}s`, stopLatency <= STOP_LATENCY_LIMIT_MS,
      `${stopLatency}ms`);
    test(`abort 后新增 chunk ≤${CHUNK_SLACK_AFTER_ABORT}`,
      state.chunksAfterAbort <= CHUNK_SLACK_AFTER_ABORT,
      `chunksAfterAbort=${state.chunksAfterAbort}`);
    test("模型未在 abort 前自然结束（任务量足够）", state.endBeforeAbortAt === null,
      "message_end 先于 abort 到达 — 增大任务量或提前 abort");

    console.log(`       chunks=${state.totalChunks} afterAbort=${state.chunksAfterAbort} stopLatency=${stopLatency}ms`);
  }
} catch (e) {
  test("测试执行", false, e.message);
} finally {
  await cleanup();
  try { ws.close(); } catch {}
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  ${passed} 通过  ${failed} 失败  / ${passed + failed}`);
console.log(`${"=".repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
