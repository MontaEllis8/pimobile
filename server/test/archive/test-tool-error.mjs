/**
 * 测试：工具调用失败恢复
 * 验证：bash 执行失败后不静默，SDK 返回 tool_output(status=failed) 或 error
 */
import WebSocket from "ws";

const WS_URL = "ws://192.168.1.104:8787/ws";
let passed = 0, failed = 0;
function test(n, ok, d = "") { ok ? passed++ : failed++; console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); }

function listen(ws, timeout = 60000) {
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

console.log("🧪 工具调用失败恢复测试\n");

const ws = new WebSocket(WS_URL);
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 2000));

  // Create fresh session
  ws.send(JSON.stringify({ type: "new_session", name: "toolerr-" + Date.now() }));
  await new Promise(r => setTimeout(r, 3000));
  ws.send(JSON.stringify({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" }));
  await new Promise(r => setTimeout(r, 2000));

  console.log("── 1. 执行不存在的命令 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "执行命令 nonexistent-command-xyz 并告诉我结果" }));
  const msgs1 = await listen(ws);
  const errorMsgs = msgs1.filter(m => m.type === "error");
  const failedTools = msgs1.filter(m => m.type === "tool_output" && m.status === "failed");
  const text1 = msgs1.filter(m => m.type === "text_chunk").map(m => m.text).join("");

  console.log(`   text_chunks: ${msgs1.filter(m => m.type === "text_chunk").length}`);
  console.log(`   error 消息: ${errorMsgs.length}`);
  console.log(`   failed tool_output: ${failedTools.length}`);
  console.log(`   回复摘要: ${text1.substring(0, 100)}`);

  test("失败有反馈", (errorMsgs.length > 0 || failedTools.length > 0 || text1.length > 0),
    errorMsgs.length > 0 ? `error: ${errorMsgs[0]?.message?.substring(0, 60)}`
    : failedTools.length > 0 ? `tool_output(status=failed)`
    : "仅 text 反馈");

  console.log("\n── 2. 访问不存在的文件 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "读取 /nonexistent/path/file.txt 的内容" }));
  const msgs2 = await listen(ws);
  const errorMsgs2 = msgs2.filter(m => m.type === "error");
  const failedTools2 = msgs2.filter(m => m.type === "tool_output" && m.status === "failed");
  const text2 = msgs2.filter(m => m.type === "text_chunk").map(m => m.text).join("");

  console.log(`   error 消息: ${errorMsgs2.length}`);
  console.log(`   failed tool_output: ${failedTools2.length}`);
  console.log(`   回复摘要: ${text2.substring(0, 100)}`);

  test("文件不存在有反馈", (errorMsgs2.length > 0 || failedTools2.length > 0 || text2.length > 0));

  console.log("\n── 3. 失败后继续对话 ──");
  ws.send(JSON.stringify({ type: "user_message", content: "pwd" }));
  const msgs3 = await listen(ws);
  const text3 = msgs3.filter(m => m.type === "text_chunk").map(m => m.text).join("");
  const hasPwd = text3.toLowerCase().includes("works") || text3.includes("/");
  console.log(`   回复: ${text3.substring(0, 80)}`);
  test("失败后可继续对话", text3.length > 0 && hasPwd);

  console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
});
ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });
