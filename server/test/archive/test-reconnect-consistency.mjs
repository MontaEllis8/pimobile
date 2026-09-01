/**
 * 测试：断线重连数据一致性
 * 验证：重连后 context_window / model / session_list 与断线前一致
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
let passed = 0, failed = 0;
function test(n, ok, d = "") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); }

function listen(ws, timeout = 30000) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => { ws.off("message", h); resolve(msgs); }, timeout);
    const h = (data) => {
      try {
        const m = JSON.parse(data.toString());
        msgs.push(m);
        if (m.type === "message_end") { clearTimeout(timer); ws.off("message", h); resolve(msgs); }
      } catch {}
    };
    ws.on("message", h);
  });
}

console.log("🧪 断线重连数据一致性测试\n");

// Step 1: 首次连接，采集基线数据
const ws1 = new WebSocket(WS_URL);
ws1.on("open", async () => {
  await new Promise(r => setTimeout(r, 2000));

  // Create a fresh session
  ws1.send(JSON.stringify({ type: "new_session", name: "reconnect-" + Date.now() }));
  await new Promise(r => setTimeout(r, 3000));
  ws1.send(JSON.stringify({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" }));
  await new Promise(r => setTimeout(r, 2000));

  // Get baseline state
  let msgs = [];
  const h = (d) => { try { msgs.push(JSON.parse(d.toString())); } catch {} };
  ws1.on("message", h);
  ws1.send(JSON.stringify({ type: "get_state" }));
  await new Promise(r => setTimeout(r, 2000));
  const stateUpdates = msgs.filter(m => m.type === "state_update");
  const lastState = stateUpdates[stateUpdates.length - 1];
  ws1.off("message", h);

  if (!lastState) { test("获取基线状态", false, "无 state_update"); ws1.close(); process.exit(1); return; }

  const baselineCtx = lastState.context_window;
  const baselineMsgs = lastState.message_count;
  const baselineThink = lastState.thinking_level;
  console.log(`  基线: ctx=${baselineCtx}, msgs=${baselineMsgs}, think=${baselineThink}`);

  // Send a message to increase message count
  ws1.send(JSON.stringify({ type: "user_message", content: "say 'reconnect check'" }));
  await listen(ws1, 60000);

  // Get updated state
  msgs = [];
  ws1.on("message", h);
  ws1.send(JSON.stringify({ type: "get_state" }));
  await new Promise(r => setTimeout(r, 2000));
  const afterState = msgs.filter(m => m.type === "state_update").pop();
  ws1.off("message", h);

  if (!afterState) { test("获取更新后状态", false); ws1.close(); process.exit(1); return; }

  const preDisconnectCtx = afterState.context_window;
  const preDisconnectMsgs = afterState.message_count;
  console.log(`  发送后: ctx=${preDisconnectCtx}, msgs=${preDisconnectMsgs}`);

  test("消息数增加", preDisconnectMsgs > baselineMsgs,
    `${baselineMsgs} → ${preDisconnectMsgs}`);

  // Get session list as well — re-attach listener first
  msgs = [];
  ws1.on("message", h);
  ws1.send(JSON.stringify({ type: "get_sessions" }));
  await new Promise(r => setTimeout(r, 2000));
  ws1.off("message", h);
  const sessionListPre = msgs.filter(m => m.type === "session_list").pop();
  const sessionCountPre = sessionListPre?.sessions?.length || 0;
  console.log(`  断线前会话数: ${sessionCountPre}`);
  test("session_list 非空", sessionCountPre > 0);

  // Step 3: 断开连接
  ws1.close();
  console.log("\n── 断开连接，等待 2 秒后重连 ──");
  await new Promise(r => setTimeout(r, 2000));

  // Step 4: 重连
  const ws2 = new WebSocket(WS_URL);
  ws2.on("open", async () => {
    await new Promise(r => setTimeout(r, 3000));

    const msgs2 = [];
    ws2.on("message", (d) => { try { msgs2.push(JSON.parse(d.toString())); } catch {} });
    ws2.send(JSON.stringify({ type: "get_sessions" }));
    await new Promise(r => setTimeout(r, 2000));
    ws2.send(JSON.stringify({ type: "get_state" }));
    await new Promise(r => setTimeout(r, 2000));

    const reconnectState = msgs2.filter(m => m.type === "state_update").pop();
    if (!reconnectState) { test("重连后 get_state", false, "无响应"); ws2.close(); process.exit(1); return; }

    const reconnectCtx = reconnectState.context_window;
    const reconnectMsgs = reconnectState.message_count;
    const reconnectThink = reconnectState.thinking_level;
    console.log(`  重连后: ctx=${reconnectCtx}, msgs=${reconnectMsgs}, think=${reconnectThink}`);

    test("context_window 一致", reconnectCtx === preDisconnectCtx,
      `${preDisconnectCtx} === ${reconnectCtx}`);
    test("message_count 一致", reconnectMsgs === preDisconnectMsgs,
      `${preDisconnectMsgs} === ${reconnectMsgs}`);
    test("thinking_level 一致", (reconnectThink || "off") === (baselineThink || "off"),
      `${reconnectThink} === ${baselineThink}`);

    // Verify session_list still available
    const reconnectSessions = msgs2.filter(m => m.type === "session_list").pop();
    const sessionCountPost = reconnectSessions?.sessions?.length || 0;
    console.log(`  重连后会话数: ${sessionCountPost}`);
    test("重连后 session_list 非空", sessionCountPost > 0);

    console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
    ws2.close();
    process.exit(failed > 0 ? 1 : 0);
  });
});
ws1.on("error", (e) => { console.error("❌", e.message); process.exit(1); });
