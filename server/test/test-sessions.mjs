/**
 * Session Architecture Regression Test
 *
 * Tests the v3.2 Map key fix: UUID-based keys, proper naming, parent sessions.
 *
 * Usage: server must be running (npm run start or npx tsx src/index.ts)
 *   node server/test-sessions.mjs
 */
import WebSocket from "ws";

const HOST = "127.0.0.1";
const PORT = 8787;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

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

async function connect(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => { if (settled) return; settled = true; cleanup(); resolve({ ok: true, ws }); };
      const onClose = (code) => { if (settled) return; if (code === 4002) { settled = true; cleanup(); try { ws.close(); } catch {} resolve({ ok: false, code }); } };
      const onError = () => {};
      const cleanup = () => { ws.off("open", onOpen); ws.off("close", onClose); ws.off("error", onError); };
      ws.on("open", onOpen); ws.on("close", onClose); ws.on("error", onError);
      setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ ok: false, code: 0 }); }, 5000);
    });
    if (result.ok && result.ws) { if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`); return result.ws; }
    if (result.code === 4002 && attempt < maxRetries) { const delay = 500 + Math.random() * 1000; console.log(`  ⚠️  收到 4002 — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`); await new Promise(r => setTimeout(r, delay)); continue; }
    throw new Error(`Connection failed after ${maxRetries} attempts (code=${result.code})`);
  }
  throw new Error('connect retry exhausted');
}

console.log("\n🧪 Session Architecture Regression Test\n");

let ws;
try { ws = await connect(); } catch (e) { console.error("Cannot connect:", e.message); process.exit(1); }

// Wait for session_list on connect
console.log("── Test A: Session Loading (UUID keys, no collision) ──\n");
const sl = await waitMessage(ws, "session_list", 10000);
test("收到 session_list", sl !== null);
if (!sl) { console.log("SERVER NOT RESPONDING"); ws.close(); process.exit(1); }

test("session_list 有 sessions 数组", sl.sessions != null && Array.isArray(sl.sessions));

const sessions = sl.sessions || [];
const sessionCount = sessions.length;
console.log(`       ${sessionCount} sessions loaded`);

// A1: All sessions should have unique session_id (no collision)
const ids = sessions.map(s => s.session_id || s.name);
const uniqueIds = new Set(ids);
test("所有 session_id 唯一（无键碰撞）", ids.length === uniqueIds.size,
  `${ids.length} sessions, ${uniqueIds.size} unique IDs`);

// A2: At least some sessions should have proper names (not all "unnamed")
const unnamedCount = sessions.filter(s => s.name === "unnamed").length;
const namedCount = sessions.filter(s => s.name !== "unnamed").length;
test("大部分 session 有非 unnamed 名称", namedCount >= sessionCount * 0.7,
  `${namedCount}/${sessionCount} named, ${unnamedCount} unnamed`);

// A3: Display names should come from SDK data
const withDisplayName = sessions.filter(s => s.display_name && s.display_name.length > 1);
test("session 有 display_name（来自 SDK）", withDisplayName.length > 0,
  `${withDisplayName.length} have display_name`);

// A4: Check for Chinese first messages (Pi terminal naming)
const chineseNames = sessions.filter(s => /[\u4e00-\u9fff]/.test(s.display_name || s.name));
console.log(`       ${chineseNames.length} sessions have Chinese names (= SDK firstMessage)`);

// A5: Current flag
const currentCount = sessions.filter(s => s.current).length;
test("有且仅有一个 current session", currentCount === 1, `${currentCount} current`);

// A6: Status field
const statuses = new Set(sessions.map(s => s.status));
test("session 有 status 字段", statuses.size > 0,
  `status values: ${[...statuses].join(", ")}`);

// A7: Last active time
const withLastActive = sessions.filter(s => (s.last_active || 0) > 0);
test("session 有 last_active 时间戳", withLastActive.length > 0,
  `${withLastActive.length} have timestamps`);

// A8: Project paths
const projects = new Set(sessions.map(s => s.project).filter(Boolean));
test("session 有 project 路径", projects.size > 0,
  `${projects.size} distinct projects:`);
if (projects.size <= 5) console.log(`       ${[...projects].join(", ")}`);
else console.log(`       ${[...projects].slice(0, 3).join(", ")} ... +${projects.size - 3} more`);

console.log("\n── Test B: Parent Session Relationships ──\n");

// B1: Some sessions should have parent_session
const withParent = sessions.filter(s => s.parent_session);
const withParentCount = withParent.length;
test("存在 parent_session 字段", sessions.some(s => s.parent_session !== undefined),
  withParentCount > 0 ? `${withParentCount} sessions have parent` : "all null (may be correct if no fork/branch happened)");
if (withParentCount > 0) {
  // B2: Parent session should exist in the list.
  // parent_session is the parent's session_id (UUID). Compare it against the
  // session_id set — NOT the display-name set: display names are human labels
  // (Chinese first messages etc.), never equal to a UUID, so a name-set
  // comparison flags every parent as an orphan (the historical "26 orphans"
  // was this false positive, see 2026-08-12 audit: real orphans = 0).
  // The server only emits parent_session when the parent resolved inside its
  // loaded set (SessionRegistry.init pathToId), so a mismatch here is real.
  const sessionIds = new Set(sessions.map(s => s.session_id));
  const orphanCount = withParent.filter(s => !sessionIds.has(s.parent_session)).length;
  test("parent_session 指向存在的会话", orphanCount === 0,
    orphanCount > 0 ? `${orphanCount} orphans` : "all parents found");
  // B3: Display parent example
  const example = withParent[0];
  test("parent_session 示例可读", typeof example.parent_session === "string" && example.parent_session.length > 0,
    `${example.name} → ${example.parent_session}`);
}

console.log("\n── Test C: Session Creation with cwd ──\n");

const testName = `arch-test-${Date.now()}`;
ws.send(JSON.stringify({ type: "new_session", name: testName, cwd: "D:\\worksave\\10-pi" }));
const sw = await waitMessage(ws, "session_switched", 5000);
test("指定 cwd 创建成功", sw !== null);

// Get updated list
ws.send(JSON.stringify({ type: "get_sessions" }));
const sl2 = await waitMessage(ws, "session_list", 5000);
if (sl2) {
  const created = sl2.sessions.find(s => s.name === testName);
  test("新建 session 出现在列表中", created != null);
  if (created) {
    test("新建 session 的 project 正确", created.project?.includes("worksave") || created.project?.includes("10-pi"),
      `project=${created.project}`);
    test("新建 session 有 session_id", created.session_id != null && created.session_id.length > 10);
  }
}

// Cleanup
ws.send(JSON.stringify({ type: "delete_session", name: testName }));
ws.send(JSON.stringify({ type: "switch_session", name: "default" }));
await waitMessage(ws, "session_switched", 3000);

console.log("\n── Test D: Token Display (context_usage) ──\n");

ws.send(JSON.stringify({ type: "get_state" }));
let suCount = 0;
const suHandler = (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.type === "state_update") {
      suCount++;
      if (suCount === 1) {
        test("state_update 包含 context_usage", m.context_usage != null);
        if (m.context_usage) {
          test("tokens 在合理范围", m.context_usage.tokens > 0 && m.context_usage.tokens <= m.context_usage.context_window);
          test("percent 在 0-100", m.context_usage.percent >= 0 && m.context_usage.percent <= 100);
          console.log(`       ${m.context_usage.tokens} / ${m.context_usage.context_window} (${m.context_usage.percent}%)`);
        }
      }
    }
  } catch {}
};
ws.on("message", suHandler);
await new Promise(r => setTimeout(r, 3000));
ws.off("message", suHandler);
test("收到 state_update", suCount > 0, `${suCount} received`);

// ── Test E: Duplicate-name creation must activate the NEW session (P0-2 A2) ──
// Regression: new_session used to activate(name) which hit the FIRST same-name
// session in displayNames insertion order, while the reply carried the NEW id —
// three-way mismatch. Fix: activate(created.getSessionId()) + direct
// created.requestStateUpdate. Assert via the `current` flag (order-independent).
console.log("\n── Test E: Duplicate-name creation activates the NEW session (A2) ──\n");

const dupName = `dup-test-${Date.now()}`;
const switchedIds = [];
const dupHandler = (d) => {
  try {
    const m = JSON.parse(d.toString());
    if (m.type === "session_switched") switchedIds.push(m.session_id);
  } catch {}
};
ws.on("message", dupHandler);

// First creation
ws.send(JSON.stringify({ type: "new_session", name: dupName }));
await waitMessage(ws, "session_switched", 8000);
await new Promise(r => setTimeout(r, 1500)); // let init settle before second create

// Second creation with the SAME name
ws.send(JSON.stringify({ type: "new_session", name: dupName }));
await waitMessage(ws, "session_switched", 8000);
await new Promise(r => setTimeout(r, 1000)); // let both switched events land

const [dupId1, dupId2] = switchedIds;
test("同名创建两次，收到两个不同 session_id 的 switched", !!dupId1 && !!dupId2 && dupId1 !== dupId2,
  `id1=${dupId1} id2=${dupId2}`);

ws.send(JSON.stringify({ type: "get_sessions" }));
const sl3 = await waitMessage(ws, "session_list", 5000);
if (sl3) {
  const dupEntries = sl3.sessions.filter(s => s.name === dupName);
  test("列表中两个同名会话并存", dupEntries.length === 2, `${dupEntries.length} entries`);
  const cur = dupEntries.find(s => s.current);
  test("current 标记指向第二次新建的会话", !!cur && cur.session_id === dupId2,
    `current=${cur?.session_id} expect=${dupId2}`);
} else {
  test("get_sessions 返回列表", false, "timeout");
}

// Cleanup (delete by stable id — name is ambiguous by design here)
for (const id of [dupId1, dupId2].filter(Boolean)) {
  ws.send(JSON.stringify({ type: "delete_session", name: dupName, session_id: id }));
  await new Promise(r => setTimeout(r, 500));
}
ws.off("message", dupHandler);

ws.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`  ${passed} 通过  ${failed} 失败  / ${passed + failed}`);
console.log(`${"=".repeat(50)}\n`);
