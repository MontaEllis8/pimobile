/**
 * Pi Mobile 端到端集成测试
 * 模拟真实 Pi 终端操作，测试命令执行 + 文件下载
 */
import WebSocket from "ws";
import fs from "fs";
import path from "path";

const WS_URL = "ws://192.168.1.104:8787/ws";
const TIMEOUT = 120000;
const DOWNLOAD_URL = "http://192.168.1.104:8787/files";

let passed = 0;
let failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else     { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function listen(ws, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => { ws.off("message", h); resolve(msgs); }, timeout);
    const h = (data) => {
      try {
        const m = JSON.parse(data.toString());
        msgs.push(m);
        // 收到 message_end 就停（让 AI 继续跑也没意义）
        if (m.type === "message_end") { clearTimeout(timer); ws.off("message", h); resolve(msgs); }
        if (m.type === "error" && msgs.length > 1) { clearTimeout(timer); ws.off("message", h); resolve(msgs); }
      } catch {}
    };
    ws.on("message", h);
  });
}

function waitMsg(ws, type, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const h = (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === type) { clearTimeout(timer); ws.off("message", h); resolve(m); }
      } catch {}
    };
    ws.on("message", h);
  });
}

// ════════════════

const ws = new WebSocket(WS_URL);

ws.on("open", async () => {
  console.log("🧪 Pi Mobile 端到端集成测试\n");
  console.log("═".repeat(50));
  await new Promise(r => setTimeout(r, 1000));

  // ── 0. 新建 session，切 deepseek ──
  console.log("\n── 0. 环境准备 ──");
  const sessionName = "e2e-" + Date.now();
  ws.send(JSON.stringify({ type: "new_session", name: sessionName }));
  const sw = await waitMsg(ws, "session_switched", 5000);
  test("新建 session", sw?.name === sessionName);
  await new Promise(r => setTimeout(r, 1000));

  ws.send(JSON.stringify({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" }));
  const sm = await waitMsg(ws, "state_update", 5000);
  test("切换 deepseek", sm !== null);

  // ── 1. 基础命令: 查看文件 ──
  console.log("\n── 1. 命令: 查看当前目录 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "pwd" }));
  let msgs = await listen(ws);
  const tools1 = msgs.filter(m => m.type === "tool_start" || m.type === "tool_output");
  const texts1 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  console.log(`   回复摘要: ${texts1.substring(0, 150)}`);
  test("有工具调用", tools1.length > 0);
  test("有文本回复", texts1.length > 0);

  // ── 2. 命令: git status ──
  console.log("\n── 2. 命令: git status ──");
  ws.send(JSON.stringify({ type: "user_message", content: "git status" }));
  msgs = await listen(ws);
  const texts2 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const hasGit = msgs.some(m => m.type === "tool_start" && m.tool_name === "bash");
  console.log(`   回复摘要: ${texts2.substring(0, 150)}`);
  test("git 命令触发 bash 工具", hasGit);

  // ── 3. 命令: 生成文件 ──
  console.log("\n── 3. 命令: 生成文件 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "在 /tmp 下创建一个文件 test-mobile.txt，内容写 'Hello from Pi Mobile E2E test'" }));
  msgs = await listen(ws);
  const texts3 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const files = msgs.filter(m => m.type === "file_available");
  test("有文本回复", texts3.length > 0);
  
  if (files.length > 0) {
    // ── 4. 文件下载端到端 ──
    console.log("\n── 4. 文件下载端到端 ──");
    for (const f of files) {
      console.log(`   📁 file_available: id=${f.id?.substring(0,30)}... name=${f.name} size=${f.size}`);
      test("文件 size > 0", f.size > 0, `size=${f.size}`);

      // 请求下载
      ws.send(JSON.stringify({ type: "download_file", id: f.id }));
      
      // 从 HTTP 端点下载
      try {
        const httpRes = await fetch(`${DOWNLOAD_URL}/${f.id}`);
        if (httpRes.ok) {
          const content = await httpRes.text();
          console.log(`   下载内容: ${content.substring(0, 100)}`);
          test("HTTP 下载成功", content.includes("Hello from Pi Mobile"));
          test("文件内容正确", content === "Hello from Pi Mobile E2E test\n" || content === "Hello from Pi Mobile E2E test");
        } else {
          test("HTTP 下载失败", false, `HTTP ${httpRes.status}`);
        }
      } catch (e) {
        test("HTTP 下载异常", false, e.message);
      }
    }
  } else {
    console.log("   ⚠️ AI 未产生 file_available（可能用 bash 创建了但没触发 file_available）");
    test("file_available 收到", false, "AI未产生文件通知");
  }

  // ── 5. 多轮对话上下文 ──
  console.log("\n── 5. 多轮对话上下文 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "我刚才让你创建的文件叫什么名字？" }));
  msgs = await listen(ws);
  const texts5 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  console.log(`   AI 回复: ${texts5.substring(0, 200)}`);
  test("AI 记住了上下文", texts5.includes("test-mobile") || texts5.includes("test"));

  // ── 6. 获取 state 验证 ──
  console.log("\n── 6. 最终状态 ──");
  ws.send(JSON.stringify({ type: "get_state" }));
  const st = await waitMsg(ws, "state_update", 5000);
  if (st) {
    const tokens = st.cost?.total || 0;
    const msgsCount = st.message_count || 0;
    console.log(`   tokens: ${tokens}  messages: ${msgsCount}`);
    test("token 用量 > 0", tokens > 0);
    test("消息数 > 0", msgsCount > 0);
  } else {
    test("获取状态", false);
  }

  // ── 总结 ──
  console.log("\n" + "═".repeat(50));
  console.log(`  ✅ ${passed} 通过  ❌ ${failed} 失败`);
  console.log("═".repeat(50));
  
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});

ws.on("error", (e) => { console.error("❌ WebSocket 错误:", e.message); process.exit(1); });
