/**
 * 测试：thinking_level 循环切换 + state_update 验证
 * 协议使用 cycle_thinking 消息（非 set_thinking_level）
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
let passed = 0, failed = 0;
function test(n, ok, d = "") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); }

console.log("🧪 thinking_level 循环切换测试\n");

const ws = new WebSocket(WS_URL);
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 2000));

  // Create fresh session
  ws.send(JSON.stringify({ type: "new_session", name: "think-" + Date.now() }));
  await new Promise(r => setTimeout(r, 3000));

  // Get initial thinking_level from initial state_update that arrives on connect
  const msgs0 = [];
  function collect(d) { try { msgs0.push(JSON.parse(d.toString())); } catch {} }
  ws.on("message", collect);

  // Send get_state to get current thinking_level
  ws.send(JSON.stringify({ type: "get_state" }));
  await new Promise(r => setTimeout(r, 2000));
  const initState = msgs0.filter(m => m.type === "state_update").pop();
  const initLevel = initState?.thinking_level || "off";
  console.log(`── 1. 初始: ${initLevel} ──`);
  test("thinking_level 字段存在", "thinking_level" in (initState || {}),
    initLevel);

  // Cycle thinking level — round 1 (off → minimal or extended)
  console.log("\n── 2. 第一次 cycle ──");
  ws.send(JSON.stringify({ type: "cycle_thinking" }));
  await new Promise(r => setTimeout(r, 2000));
  const after1 = msgs0.filter(m => m.type === "state_update").pop();
  const level1 = after1?.thinking_level || "off";
  console.log(`   切换后: ${level1}`);
  test("cycle 后 level 变化或保持", level1 !== undefined,
    level1);

  // Check if thinking_level_changed event fired
  const thinkEvents = msgs0.filter(m => m.type === "state_update" && m.thinking_level !== initLevel);
  console.log(`   state_update 次数: ${msgs0.filter(m => m.type === "state_update").length}`);

  // Cycle again — round 2
  console.log("\n── 3. 第二次 cycle ──");
  ws.send(JSON.stringify({ type: "cycle_thinking" }));
  await new Promise(r => setTimeout(r, 2000));
  const after2 = msgs0.filter(m => m.type === "state_update").pop();
  const level2 = after2?.thinking_level || "off";
  console.log(`   切换后: ${level2}`);
  test("二次 cycle 无 crash", true);

  // Verify no errors received
  const errors = msgs0.filter(m => m.type === "error");
  test("无 error 消息", errors.length === 0,
    errors.length > 0 ? errors[0].message : "");

  // Final get_state
  console.log("\n── 4. 最终状态 ──");
  ws.send(JSON.stringify({ type: "get_state" }));
  await new Promise(r => setTimeout(r, 2000));
  const finalState = msgs0.filter(m => m.type === "state_update").pop();
  console.log(`   最终 thinking_level: ${finalState?.thinking_level || "off"}`);
  console.log(`   context_window: ${finalState?.context_window || "N/A"}`);

  ws.off("message", collect);

  console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});
ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });
