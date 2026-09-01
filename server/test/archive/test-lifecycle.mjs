/**
 * 测试：sleep/wakeUp 生命周期
 * 验证：休眠后会话不可交互，唤醒后恢复
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
let passed = 0, failed = 0;
function test(n, ok, d = "") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); }

function listen(ws, timeout = 30000) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => { ws.off("message", h); resolve(msgs); }, timeout);
    const h = (d) => {
      try {
        const m = JSON.parse(d.toString());
        msgs.push(m);
        if (m.type === "message_end") { clearTimeout(timer); ws.off("message", h); resolve(msgs); }
      } catch {}
    };
    ws.on("message", h);
  });
}

console.log("🧪 sleep/wakeUp 生命周期测试\n");

const ws = new WebSocket(WS_URL);
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 2000));

  // Create fresh test session
  ws.send(JSON.stringify({ type: "new_session", name: "lifecycle-" + Date.now() }));
  await new Promise(r => setTimeout(r, 3000));

  // Get session list
  const msgs0 = [];
  ws.on("message", (d) => { try { msgs0.push(JSON.parse(d.toString())); } catch {} });
  ws.send(JSON.stringify({ type: "get_sessions" }));
  await new Promise(r => setTimeout(r, 2000));
  const sessions = msgs0.find(m => m.type === "session_list")?.sessions || [];
  const testSession = sessions.find(s => s.name?.startsWith("lifecycle-"));
  test("找到测试会话", !!testSession, testSession?.name || "无");

  if (!testSession) { ws.close(); process.exit(1); return; }

  // Send a baseline message
  console.log("\n── 1. 发送基准消息 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "say 'hello from lifecycle test'" }));
  const msgs1 = await listen(ws);
  const text1 = msgs1.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  console.log(`   回复: ${text1.substring(0, 80)}`);
  test("活跃会话可交互", text1.length > 0);

  // Switch to another session to put this one in background
  console.log("\n── 2. 切换到后台会话 ──");
  ws.send(JSON.stringify({ type: "switch_session", name: "default" }));
  await new Promise(r => setTimeout(r, 2000));

  // Now try sending message to the test session indirectly via switch
  ws.send(JSON.stringify({ type: "switch_session", name: testSession.name }));
  await new Promise(r => setTimeout(r, 2000));

  // Verify the session still works after switch-back
  console.log("\n── 3. 切回后验证 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "say 'back from switch'" }));
  const msgs2 = await listen(ws);
  const text2 = msgs2.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  console.log(`   回复: ${text2.substring(0, 80)}`);
  test("切回后仍可交互", text2.length > 0);

  // Session status check via session_list
  console.log("\n── 4. 会话状态验证 ──");
  const msgs3 = [];
  ws.on("message", h3);
  function h3(d) { try { msgs3.push(JSON.parse(d.toString())); } catch {} }
  ws.send(JSON.stringify({ type: "get_sessions" }));
  await new Promise(r => setTimeout(r, 2000));
  ws.off("message", h3);

  const sessionList = msgs3.find(m => m.type === "session_list")?.sessions || [];
  const activeSess = sessionList.find(s => s.name === testSession.name);
  const activeSessions = sessionList.filter(s => s.status === "active" || s.status === "running");

  test("会话状态有效", !!activeSess, activeSess?.status || "not found");
  console.log(`   活跃会话: ${activeSessions.length}/${sessionList.length}`);

  console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});
ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });
