/**
 * 新功能专项测试：display_name, last_active, command_list
 */
import WebSocket from "ws";

const HOST = "192.168.1.104";
const PORT = 8787;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

let results = [];
function test(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${" ".repeat(55 - name.length)}${name}  ${passed ? "✅" : "❌"}`);
  if (detail) console.log(`        ${detail}`);
}

function waitMessage(ws, type, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off("message", handler); resolve(null); }, timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) { clearTimeout(timer); ws.off("message", handler); resolve(msg); }
        else if (msg.type === "error") { clearTimeout(timer); ws.off("message", handler); resolve({ _error: msg.message, ...msg }); }
      } catch {}
    };
    ws.on("message", handler);
  });
}

function waitAllMessages(ws, timeout = 60000) {
  return new Promise((resolve) => {
    const collected = [];
    const timer = setTimeout(() => { ws.off("message", handler); resolve(collected); }, timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        collected.push(msg);
        if (msg.type === "message_end" || msg.type === "error") { clearTimeout(timer); ws.off("message", handler); resolve(collected); }
      } catch {}
    };
    ws.on("message", handler);
  });
}

async function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
}

async function drain(ws, timeout = 2000) {
  return new Promise(r => {
    ws.on("message", () => {});
    setTimeout(r, timeout);
  });
}

console.log("\n🧪 新功能专项测试\n");

const ws = await connect();
// Drain initial messages
await drain(ws, 1000);

console.log("\n── 测试 1: command_list 自动推送 ──\n");
// Reconnect to get fresh messages
ws.close();
await new Promise(r => setTimeout(r, 500));
const ws2 = await connect();

const cl = await waitMessage(ws2, "command_list", 5000);
const cmdCount = cl?.commands?.length || 0;
test("自动推送 command_list", cl !== null && cmdCount > 0, `${cmdCount} 个命令`);
if (cmdCount > 0) {
  cl.commands.slice(0, 5).forEach(c => console.log(`     ${c.name} - ${c.description || ""}`));
  const hasNew = cl.commands.some(c => c.name === "/new");
  test("包含 /new", hasNew);
}

console.log("\n── 测试 2: command_list 显式请求 ──\n");
ws2.send(JSON.stringify({ type: "get_commands" }));
const cl2 = await waitMessage(ws2, "command_list", 5000);
const cmdCount2 = cl2?.commands?.length || 0;
test("get_commands 返回命令", cl2 !== null && cmdCount2 > 0, `${cmdCount2} 个命令`);
if (cmdCount2 > 0) {
  const hasCompact = cl2.commands.some(c => c.name === "/compact");
  test("包含 /compact", hasCompact);
  test("所有命令有 name", cl2.commands.every(c => c.name?.length > 0));
  test("命令数 >= 20", cmdCount2 >= 20, `${cmdCount2}`);
}

console.log("\n── 测试 3: 自动命名 (display_name) ──\n");
const ts = `autoname-${Date.now()}`;
ws2.send(JSON.stringify({ type: "new_session", name: ts }));
const sw = await waitMessage(ws2, "session_switched", 5000);
test("创建 session", sw !== null, sw?.name || "");

const testMsg = "你好，我想写一个Python脚本读取CSV文件";
ws2.send(JSON.stringify({ type: "user_message", content: testMsg }));
const done = await waitAllMessages(ws2, 45000);
const hasEnd = done.some(m => m.type === "message_end");
const hasError = done.some(m => m.type === "error");
test("收到 message_end 或 error", hasEnd || hasError, hasError ? `error: ${done.find(m=>m.type==="error")?.message}` : "message_end");

ws2.send(JSON.stringify({ type: "get_sessions" }));
const sl = await waitMessage(ws2, "session_list", 5000);
const myS = sl?.sessions?.find(s => s.name === ts);
const dn = myS?.display_name || "";
test("session 有 display_name", dn.length > 0, `"${dn.substring(0, 30)}..."`);
test("display_name 匹配首句", dn === testMsg.substring(0, 40),
  `期望="${testMsg.substring(0, 40)}" 实际="${dn}"`);

console.log("\n── 测试 4: last_active 排序 ──\n");
const ts1 = `time-1-${Date.now()}`;
ws2.send(JSON.stringify({ type: "new_session", name: ts1 }));
await waitMessage(ws2, "session_switched", 5000);
ws2.send(JSON.stringify({ type: "user_message", content: "hello" }));
await waitAllMessages(ws2, 45000);

const ts2 = `time-2-${Date.now()}`;
ws2.send(JSON.stringify({ type: "new_session", name: ts2 }));
await waitMessage(ws2, "session_switched", 5000);
ws2.send(JSON.stringify({ type: "user_message", content: "world" }));
await waitAllMessages(ws2, 45000);

ws2.send(JSON.stringify({ type: "get_sessions" }));
const sl2 = await waitMessage(ws2, "session_list", 5000);
const s1 = sl2?.sessions?.find(s => s.name === ts1);
const s2 = sl2?.sessions?.find(s => s.name === ts2);
const hasLA = s1?.last_active > 0 && s2?.last_active > 0;
test("sessions 有 last_active", hasLA, `s1=${s1?.last_active} s2=${s2?.last_active}`);
test("s2 > s1 (后创建)", (s2?.last_active || 0) >= (s1?.last_active || 0));

// Cleanup
ws2.send(JSON.stringify({ type: "delete_session", name: ts }));
await waitMessage(ws2, "session_switched", 5000);
ws2.send(JSON.stringify({ type: "delete_session", name: ts1 }));
await waitMessage(ws2, "session_switched", 5000);
ws2.send(JSON.stringify({ type: "delete_session", name: ts2 }));
await waitMessage(ws2, "session_switched", 5000);
ws2.close();

// Summary
const passed = results.filter(r => r.passed).length;
console.log(`\n${"=".repeat(60)}`);
console.log(`  ${passed}/${results.length} 通过\n`);
if (passed < results.length) {
  results.filter(r => !r.passed).forEach(r => console.log(`    ❌ ${r.name} — ${r.detail}`));
}
console.log(`${"=".repeat(60)}\n`);
