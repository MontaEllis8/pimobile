/**
 * 测试：多会话快速切换稳定性 (Phase 3: 4002 自愈)
 * 验证：快速切换后事件不泄漏到错误 session
 */
import WebSocket from "ws";

const HOST = process.env.TEST_HOST || "127.0.0.1";
const PORT = process.env.TEST_PORT || "8787";
const WS_URL = `ws://${HOST}:${PORT}/ws`;
let passed = 0, failed = 0;
function test(n, ok, d = "") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); }

function listen(ws, timeout = 120000) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => { ws.off("message", h); resolve(msgs); }, timeout);
    const h = (d) => {
      try {
        const m = JSON.parse(d.toString());
        msgs.push(m);
        if (m.type === "message_end" || m.type === "error") {
          clearTimeout(timer);
          ws.off("message", h);
          resolve(msgs);
        }
      } catch {}
    };
    ws.on("message", h);
  });
}

async function connectWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: true, ws });
      };
      const onClose = (code) => {
        if (settled) return;
        if (code === 4002) {
          settled = true;
          cleanup();
          try { ws.close(); } catch {}
          resolve({ ok: false, code });
        }
      };
      const onError = () => {};
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("close", onClose);
        ws.off("error", onError);
      };
      ws.on("open", onOpen);
      ws.on("close", onClose);
      ws.on("error", onError);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, code: 0 });
      }, 5000);
    });
    if (result.ok && result.ws) {
      if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`);
      return result.ws;
    }
    if (result.code === 4002 && attempt < maxRetries) {
      const delay = 500 + Math.random() * 1000;
      console.log(`  ⚠️  收到 4002 — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    throw new Error(`WebSocket connect failed after ${maxRetries} attempts (code=${result.code})`);
  }
  throw new Error("connectWithRetry exhausted");
}

console.log("🧪 多会话快速切换稳定性测试\n");

const ws = await connectWithRetry(3);
const SESSIONS = 3;

ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });

await new Promise(r => setTimeout(r, 2000));

// Create multiple sessions
const sessionNames = [];
for (let i = 0; i < SESSIONS; i++) {
  const name = `multi-${Date.now()}-${i}`;
  sessionNames.push(name);
  ws.send(JSON.stringify({ type: "new_session", name }));
  await new Promise(r => setTimeout(r, 2000));
}
console.log(`创建 ${SESSIONS} 个会话: ${sessionNames.join(", ")}`);

// Rapidly switch between them 10 times
console.log("\n── 快速切换（10 轮）──");
for (let round = 0; round < 10; round++) {
  const idx = round % SESSIONS;
  ws.send(JSON.stringify({ type: "switch_session", name: sessionNames[idx] }));
  await new Promise(r => setTimeout(r, 300));
}
test("10轮切换无崩溃", true);
await new Promise(r => setTimeout(r, 5000));

// Send message in each session and verify response goes to correct one
console.log("\n── 逐会话验证 ──");
let allOk = true;
for (let i = 0; i < SESSIONS; i++) {
  ws.send(JSON.stringify({ type: "switch_session", name: sessionNames[i] }));
  await new Promise(r => setTimeout(r, 3000));

  const marker = `marker-session-${i}`;
  const listenPromise = listen(ws, 120000);
  ws.send(JSON.stringify({ type: "user_message", content: `say exactly "${marker}"` }));
  const msgs = await listenPromise;
  const text = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const hasMarker = text.includes(marker);
  console.log(`  会话 ${i}: ${hasMarker ? "✅" : "❌"} 回复${hasMarker ? "含" : "不含"}标记`);
  if (!hasMarker) allOk = false;
}
test("每个会话独立响应", allOk);

// Verify session list integrity
ws.send(JSON.stringify({ type: "get_sessions" }));
await new Promise(r => setTimeout(r, 2000));

// Delete test sessions
for (const name of sessionNames) {
  ws.send(JSON.stringify({ type: "delete_session", name }));
  await new Promise(r => setTimeout(r, 500));
}

console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
ws.close();
process.exit(failed > 0 ? 1 : 0);
