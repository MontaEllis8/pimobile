/**
 * Round 3 regression test — covers today's changes:
 *   1. context_usage in state_update (token display)
 *   2. read tool triggers file_available
 *   3. new_session with cwd parameter
 *   4. file_available with content_type
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
const HTTP_URL = "http://192.168.1.104:8787";
let passed = 0, failed = 0;

function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} — ${detail}`); }
}

function waitMessage(ws, type, timeout = 15000) {
  return new Promise(r => {
    const t = setTimeout(() => { ws.off("message", h); r(null); }, timeout);
    const h = (d) => { try { const m = JSON.parse(d.toString()); if (m.type === type) { clearTimeout(t); ws.off("message", h); r(m); } } catch {} };
    ws.on("message", h);
  });
}

function waitAll(ws, timeout = 60000) {
  return new Promise(r => {
    const msgs = [];
    const t = setTimeout(() => { ws.off("message", h); r(msgs); }, timeout);
    const h = (d) => {
      try { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "message_end" || m.type === "error") { clearTimeout(t); ws.off("message", h); r(msgs); } } catch {}
    };
    ws.on("message", h);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

console.log("\n🧪 Round 3 回归测试\n");

let ws;
try { ws = await connect(); } catch (e) { console.error("Cannot connect:", e.message); process.exit(1); }
await new Promise(r => { ws.on("message", () => {}); setTimeout(r, 1000); });

// ─────────────────────────────────────────
// Test 1: context_usage in state_update
// ─────────────────────────────────────────
console.log("── Test 1: Token 显示 (context_usage) ──\n");

// Trigger state update by switching models
ws.send(JSON.stringify({ type: "get_state" }));
const suMsgs = [];
const suTimer = setTimeout(() => {}, 5000);
const suHandler = (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.type === "state_update") suMsgs.push(m);
  } catch {}
};
ws.on("message", suHandler);
await new Promise(r => setTimeout(r, 3000));
ws.off("message", suHandler);

const stateUpdates = suMsgs.filter(m => m.type === "state_update");
const latestSU = stateUpdates[stateUpdates.length - 1];
if (latestSU) {
  const hasContext = latestSU.context_usage !== undefined;
  test("state_update 包含 context_usage", hasContext);
  if (hasContext && latestSU.context_usage) {
    test("context_usage 有 tokens", latestSU.context_usage.tokens !== undefined);
    test("context_usage 有 context_window", latestSU.context_usage.context_window !== undefined);
    test("context_usage 有 percent", latestSU.context_usage.percent !== undefined);
    console.log(`       tokens=${latestSU.context_usage.tokens} ctx=${latestSU.context_usage.context_window} pct=${latestSU.context_usage.percent}%`);
  }
  // Also check old cost field still exists (backward compat)
  test("state_update 仍包含 cost.total（向后兼容）", latestSU.cost?.total !== undefined);
} else {
  test("收到 state_update", false, "0 条");
}

// ─────────────────────────────────────────
// Test 2: read tool → file_available
// ─────────────────────────────────────────
console.log("\n── Test 2: read 工具触发 file_available ──\n");

const sn = `round3-test-${Date.now()}`;
ws.send(JSON.stringify({ type: "new_session", name: sn }));
await waitMessage(ws, "session_switched", 5000);

// Create a file first, then read it — read should trigger file_available
ws.send(JSON.stringify({ type: "user_message", content: "创建一个简单的 Python 文件 test_read.py，内容只有一行注释 # hello，用 write 工具保存，然后用 read 工具读取它，告诉我读到什么" }));
const msgs = await waitAll(ws, 60000);

const fileMsgs = msgs.filter(m => m.type === "file_available");
const writeFiles = fileMsgs.filter(m => m.name?.endsWith(".py"));
test("write 后推送 file_available", writeFiles.length > 0);
// Check if read triggered file_available too (should have 2 entries: write + read)
const readFiles = fileMsgs.filter(m => m.name === "test_read.py");
test("read 工具也推送 file_available", readFiles.length >= 2, `共 ${readFiles.length} 条`);
if (readFiles.length > 0) {
  test("file_available 有 content_type", readFiles.every(f => f.content_type != null));
}

// ─────────────────────────────────────────
// Test 3: new_session with cwd
// ─────────────────────────────────────────
console.log("\n── Test 3: new_session 指定 cwd ──\n");

const testCwd = "/tmp";
ws.send(JSON.stringify({ type: "new_session", name: "cwd-test", cwd: testCwd }));
const sw = await waitMessage(ws, "session_switched", 5000);
test("指定 cwd 创建 session 成功", sw !== null, sw?.name || "");

// Get session list and verify
ws.send(JSON.stringify({ type: "get_sessions" }));
const sl = await waitMessage(ws, "session_list", 5000);
if (sl && sl.sessions) {
  const cwdSession = sl.sessions.find(s => s.name === "cwd-test");
  test("session_list 包含新 session", cwdSession != null);
  if (cwdSession) {
    test("session 的 project 匹配 cwd", cwdSession.project === testCwd || cwdSession.project?.includes("tmp"), cwdSession.project);
    console.log(`       name=${cwdSession.name} project=${cwdSession.project}`);
  }
}

// Cleanup: delete test sessions, switch back
ws.send(JSON.stringify({ type: "delete_session", name: "cwd-test" }));
ws.send(JSON.stringify({ type: "switch_session", name: "default" }));
await waitMessage(ws, "session_switched", 3000);

ws.close();

console.log(`\n${"=".repeat(40)}`);
console.log(`  ${passed} 通过  ${failed} 失败  /${passed + failed}`);
console.log(`${"=".repeat(40)}\n`);
