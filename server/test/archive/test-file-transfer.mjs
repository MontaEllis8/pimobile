/**
 * 文件自动检测 & 下载专项测试
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
    const msgs = []; const t = setTimeout(() => { ws.off("message", h); r(msgs); }, timeout);
    const h = (d) => { try { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === "message_end" || m.type === "error") { clearTimeout(t); ws.off("message", h); r(msgs); } } catch {} };
    ws.on("message", h);
  });
}
function connect() { return new Promise((resolve, reject) => { const ws = new WebSocket(WS_URL); ws.on("open", () => resolve(ws)); ws.on("error", reject); setTimeout(() => reject(new Error("connect timeout")), 5000); }); }

console.log("\n🧪 文件检测专项测试\n");

let ws;
try { ws = await connect(); } catch (e) { console.error("Cannot connect:", e.message); process.exit(1); }

// Drain initial messages
await new Promise(r => { ws.on("message", () => {}); setTimeout(r, 1000); });

console.log("── 测试 1: write 工具后自动推送 file_available ──\n");

// Create test session
const sn = `file-test-${Date.now()}`;
ws.send(JSON.stringify({ type: "new_session", name: sn }));
const sw = await waitMessage(ws, "session_switched", 5000);
test("创建测试 session", sw !== null, sw?.name);

// Ask agent to create a file
ws.send(JSON.stringify({ type: "user_message", content: "创建一个HTML文件 hello.html，内容是一段简单的问候页面，包含标题和段落" }));
const msgs = await waitAll(ws, 60000);

const fileMsgs = msgs.filter(m => m.type === "file_available");
const hasFile = fileMsgs.length > 0;
test("agent 写文件后收到 file_available", hasFile, `共 ${fileMsgs.length} 条`);
if (hasFile) {
  fileMsgs.forEach(f => console.log(`       name=${f.name} size=${f.size} content_type=${f.content_type || "none"}`));
  const hasHtml = fileMsgs.some(f => f.content_type === "text/html");
  test("content_type 为 text/html", hasHtml);
  const hasName = fileMsgs.every(f => f.name && f.name.length > 0);
  test("file_available 有 name", hasName);
  const hasSize = fileMsgs.every(f => f.size > 0);
  test("file_available 有 size", hasSize);
}

console.log("\n── 测试 2: HTTP 文件下载端点 ──\n");

if (fileMsgs.length > 0) {
  const fid = fileMsgs[0].id;
  try {
    const res = await fetch(`http://192.168.1.104:8787/files/${encodeURIComponent(fid)}`);
    test("HTTP 下载返回 200", res.status === 200, `status=${res.status}`);
    const ct = res.headers.get("content-type");
    test("Content-Type 为 text/html", ct?.startsWith("text/html") || false, ct || "none");
    const cd = res.headers.get("content-disposition");
    test("Content-Disposition 为 inline", cd === "inline", cd || "none");
    const body = await res.text();
    test("响应体不为空", body.length > 0, `${body.length} bytes`);
    console.log(`   [预览] ${body.substring(0, 100)}...`);
  } catch (e) {
    test("HTTP 下载成功", false, e.message);
  }
}

console.log("\n── 测试 3: 非 HTML 文件 MIME 检测 ──\n");

ws.send(JSON.stringify({ type: "user_message", content: "创建一个Python文件 test_calc.py，里面写一个简单的加法计算器函数，加上#注释" }));
const msgs2 = await waitAll(ws, 60000);
const pyMsgs = msgs2.filter(m => m.type === "file_available");
const pyFile = pyMsgs.find(f => f.name?.endsWith(".py"));
test("py 文件触发 file_available", pyFile != null);
if (pyFile) {
  test("py content_type 包含 python", pyFile.content_type?.includes("python") || false, pyFile.content_type);
  const res = await fetch(`http://192.168.1.104:8787/files/${encodeURIComponent(pyFile.id)}`);
  test("HTTP 200", res.status === 200);
  const cd = res.headers.get("content-disposition");
  test("disposition 为 attachment (非 inline)", cd?.startsWith("attachment") || false, cd?.substring(0, 40));
}

// Cleanup
ws.send(JSON.stringify({ type: "delete_session", name: sn }));
await waitMessage(ws, "session_switched", 5000);
ws.close();

console.log(`\n${"=".repeat(40)}`);
console.log(`  ${passed} 通过  ${failed} 失败  /${passed + failed}`);
console.log(`${"=".repeat(40)}\n`);
