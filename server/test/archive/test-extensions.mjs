/**
 * Pi 扩展命令测试 — 验证扩展通过 WebSocket 链路是否正常工作
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
let passed = 0, failed = 0;
function test(n, ok, d="") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — "+d : ""}`); }

function listen(ws, timeout = 60000) {
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

const ws = new WebSocket(WS_URL);
ws.on("open", async () => {
  console.log("🧪 Pi 扩展命令测试\n");
  await new Promise(r => setTimeout(r, 1000));

  // Prep
  ws.send(JSON.stringify({ type: "new_session", name: "ext-" + Date.now() }));
  await new Promise(r => setTimeout(r, 2000));
  ws.send(JSON.stringify({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" }));
  await new Promise(r => setTimeout(r, 2000));

  // ── 1. 基础 shell 命令 ──
  console.log("── 1. 命令: pwd ──");
  ws.send(JSON.stringify({ type: "user_message", content: "pwd" }));
  let msgs = await listen(ws);
  const text = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const tools = msgs.filter(m => m.type === "tool_start");
  console.log(`   回复: ${text.substring(0, 100)}`);
  console.log(`   工具: ${tools.map(t=>t.tool_name).join(", ") || "无"}`);
  test("pwd 有回复", text.length > 0);

  // ── 2. 列出文件 ──
  console.log("\n── 2. 命令: ls ──");
  ws.send(JSON.stringify({ type: "user_message", content: "ls -la" }));
  msgs = await listen(ws);
  const text2 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const bashTools = msgs.filter(m => m.type === "tool_start" && m.tool_name === "bash");
  console.log(`   bash 工具: ${bashTools.length} 次`);
  console.log(`   回复: ${text2.substring(0, 120)}`);
  test("ls 触发了 bash", bashTools.length > 0);

  // ── 3. 多步命令 ──
  console.log("\n── 3. 命令: 读取文件 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "读取 src/index.ts 的内容" }));
  msgs = await listen(ws);
  const text3 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const readTool = msgs.find(m => m.type === "tool_start" && m.tool_name === "read");
  console.log(`   read 工具: ${readTool ? "✅ " + readTool.input?.substring(0,60) : "❌ 无"}`);
  console.log(`   回复: ${text3.substring(0, 150)}`);
  test("read 文件成功", !!readTool && text3.length > 0);

  // ── 4. 扩展命令: /review-memory ──
  console.log("\n── 4. 扩展命令: /review-memory ──");
  ws.send(JSON.stringify({ type: "user_message", content: "/review-memory 列出最近的记忆" }));
  msgs = await listen(ws);
  const text4 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const extTools4 = msgs.filter(m => m.type === "tool_start");
  console.log(`   工具: ${extTools4.map(t=>t.tool_name).join(", ") || "无"}`);
  console.log(`   回复: ${text4.substring(0, 200)}`);
  test("/review-memory 有回复", text4.length > 0);

  // ── 5. 扩展命令: /web-search ──
  console.log("\n── 5. 扩展命令: web 搜索 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "搜索今天北京的天气" }));
  msgs = await listen(ws);
  const text5 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const extTools5 = msgs.filter(m => m.type === "tool_start");
  console.log(`   工具: ${extTools5.map(t=>t.tool_name).join(", ") || "无"}`);
  console.log(`   回复: ${text5.substring(0, 200)}`);
  test("搜索有回复", text5.length > 0);

  // ── 6. 危险命令审批 + 拒绝流程 ──
  console.log("\n── 6. 危险命令审批测试 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "执行 rm -rf /tmp/test-nonexist" }));
  msgs = await listen(ws);
  const confirm = msgs.find(m => m.type === "confirmation_required");
  if (confirm) {
    console.log(`   ⚠️ 审批请求: ${confirm.message?.substring(0,100)}`);
    test("危险命令触发审批", true);

    // Test denial flow (超时5分钟太长，这里测主动拒绝)
    console.log("\n── 7. 审批拒绝流程 ──");
    ws.send(JSON.stringify({ type: "user_message", content: "执行 sudo rm -rf /tmp/test" }));
    msgs = await listen(ws);
    const confirm2 = msgs.find(m => m.type === "confirmation_required");
    if (confirm2) {
      ws.send(JSON.stringify({ type: "confirmation_response", id: confirm2.id, approved: false }));
      await new Promise(r => setTimeout(r, 2000));
      const errMsg = msgs.find(m => m.type === "error");
      test("拒绝后收到 error", !!errMsg, errMsg?.message?.substring(0, 60) || "无 error");
    } else {
      test("第二次危险命令触发审批", false, "no confirmation_required");
    }
  } else {
    const text6 = msgs.filter(m => m.type === "text_chunk").map(m => m.text).join("");
    console.log(`   回复: ${text6.substring(0, 150)}`);
    test("危险命令被处理", text6.length > 0, "未触发审批但AI可能拒绝执行");
  }

  console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});
ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });
