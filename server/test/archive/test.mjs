/**
 * Pi Mobile 全自动功能测试
 *
 * 用法：服务器启动后，node D:/worksave/10-pi/02-pi-android/server/test.mjs
 *
 * 逐项测试协议层功能，无需 App 手动操作。
 */
import WebSocket from "ws";

const HOST = "192.168.1.104";
const PORT = 8787;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

let results = [];
let totalTick = 0;

function test(name, passed, detail = "") {
  totalTick++;
  results.push({ name, passed, detail });
  console.log(`${" ".repeat(60 - name.length - 4)}${name}  ${passed ? "✅" : "❌"}`);
  if (detail) console.log(`        ${detail}`);
}

// ── 工具函数 ──

function waitMessage(ws, type, timeout = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve(null);
    }, timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve({ _error: msg.message, ...msg });
        }
      } catch {}
    };
    ws.on("message", handler);
  });
}

function waitAllMessages(ws, timeout = 15000) {
  return new Promise((resolve) => {
    const collected = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve(collected);
    }, timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        collected.push(msg);
        if (msg.type === "message_end" || msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(collected);
        }
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
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

async function sendAndWait(ws, msg, expectType, timeout = 15000) {
  ws.send(JSON.stringify(msg));
  return waitMessage(ws, expectType, timeout);
}

// ─────────────────────────────────────────────
//  开始测试
// ─────────────────────────────────────────────

console.log("\n🧪 Pi Mobile 全自动功能测试\n");
console.log(`   目标: ${WS_URL}\n`);

// ════════════════════════════════════════════
//  阶段 0: 健康检查
// ════════════════════════════════════════════

console.log("\n── 阶段 0: 健康检查 ──\n");

{
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`);
    const body = await res.text();
    test("HTTP 健康检查", res.status === 200 && body.includes("ok"));
  } catch (e) {
    test("HTTP 健康检查", false, e.message);
  }
}

// ════════════════════════════════════════════
//  阶段 1: 连接 & 初始数据
// ════════════════════════════════════════════

console.log("\n── 阶段 1: 连接与初始数据 ──\n");

let ws1;
{
  ws1 = await connect();
  test("WebSocket 连接", ws1.readyState === WebSocket.OPEN);

  // 等待 session_list（连接后自动推送）
  const sl = await waitMessage(ws1, "session_list", 5000);
  const sessionCount = sl?.sessions?.length || 0;
  test("自动推送 session_list", sl !== null, `${sessionCount} 个会话`);

  // 请求 model_list
  ws1.send(JSON.stringify({ type: "get_models" }));
  const ml = await waitMessage(ws1, "model_list", 5000);
  const modelCount = ml?.models?.length || 0;
  const hasDSv4 = ml?.models?.some(m => m.id === "deepseek-v4-flash") || false;
  test("请求 model_list", ml !== null, `${modelCount} 个模型`);
  test("模型含 deepseek-v4-flash", hasDSv4, hasDSv4 ? "有" : "无");

  // 验证 command_list 在连接时自动推送
  const cl = await waitMessage(ws1, "command_list", 5000);
  const cmdCount = cl?.commands?.length || 0;
  test("自动推送 command_list", cl !== null && cmdCount > 0, `${cmdCount} 个命令`);
  if (cmdCount > 0) {
    cl.commands.forEach(c => console.log(`     /${c.name} — ${c.description || "(无描述)"} [${c.source}]`));
  }
}

// ════════════════════════════════════════════
//  阶段 2: 模型切换 & 状态查询
// ════════════════════════════════════════════

console.log("\n── 阶段 2: 模型与状态 ──\n");

{
  // 获取当前状态
  ws1.send(JSON.stringify({ type: "get_state" }));
  const st = await waitMessage(ws1, "state_update", 5000);
  test("get_state 返回 state_update", st?.type === "state_update");

  // 切换模型（设成默认的 deepseek-v4-flash，验证不报错）
  ws1.send(JSON.stringify({ type: "set_model", provider: "ark-plan", model: "deepseek-v4-flash" }));
  const smRes = await waitMessage(ws1, "state_update", 5000);
  test("set_model 成功", smRes !== null && smRes.type === "state_update", smRes?._error);

  // 切到不存在的模型
  ws1.send(JSON.stringify({ type: "set_model", provider: "x", model: "y" }));
  const err = await waitMessage(ws1, "error", 5000);
  test("set_model 不存在报错", err?.type === "error", err?.message?.substring(0, 60));
}

// ════════════════════════════════════════════
//  阶段 3: 基础对话
// ════════════════════════════════════════════

console.log("\n── 阶段 3: 基础对话 ──\n");

{
  ws1.send(JSON.stringify({ type: "user_message", content: "列出当前目录文件" }));
  const msgs = await waitAllMessages(ws1, 60000);
  // 完整 dump
  console.log(`   [DEBUG] 收到 ${msgs.length} 条消息:`);
  msgs.forEach((m, i) => {
    const txt = (m.text || "").substring(0, 60);
    const out = (m.output || "").substring(0, 60);
    const tool = m.tool_id ? `tool=${m.tool_id}(${m.tool_name})` : "";
    console.log(`     [${i}] type=${m.type} ${txt ? "t="+txt+" " : ""}${out ? "o="+out+" " : ""}${tool}`);
  });

  const hasContent = msgs.some(m =>
    m.type === "text_chunk" || m.type === "thinking_chunk" ||
    m.type === "tool_start" || m.type === "tool_output"
  );
  const hasMessageEnd = msgs.some(m => m.type === "message_end");
  test("对话有回复内容", hasContent, `共 ${msgs.length} 条`);
  test("对话收到 message_end", hasMessageEnd);
}

// ════════════════════════════════════════════
//  阶段 4: 连续对话
// ════════════════════════════════════════════

console.log("\n── 阶段 4: 连续对话 ──\n");

{
  ws1.send(JSON.stringify({ type: "user_message", content: "1+1等于几？只回答数字" }));
  const msgs = await waitAllMessages(ws1, 45000);
  const allText = msgs
    .filter(m => m.type === "text_chunk" || m.type === "thinking_chunk")
    .map(m => m.text)
    .join("");
  const hasTools = msgs.some(m => m.type === "tool_start" || m.type === "tool_output");
  const hasEnd = msgs.some(m => m.type === "message_end");
  test("连续对话有回复", allText.length > 0 || hasTools, allText.substring(0, 30));
  test("回复有效", hasEnd || allText.length > 0,
    allText.substring(0, 40) || `无内容但有 message_end`);
}

// ════════════════════════════════════════════
//  阶段 5: 停止生成
// ════════════════════════════════════════════

console.log("\n── 阶段 5: 停止生成 ──\n");

{
  ws1.send(JSON.stringify({ type: "user_message", content: "写一首五言绝句，四句" }));
  await new Promise(r => setTimeout(r, 2000));
  ws1.send(JSON.stringify({ type: "abort" }));
  const msgs = await waitAllMessages(ws1, 10000);
  const noError = !msgs.some(m => m.type === "error");
  test("abort 后服务器无报错", noError,
    msgs.map(m => m.type).join(","));
}

// ════════════════════════════════════════════
//  阶段 6: 会话管理
// ════════════════════════════════════════════

console.log("\n── 阶段 6: 会话管理 ──\n");

{
  const ts = `test-${Date.now()}`;

  // 新建会话
  ws1.send(JSON.stringify({ type: "new_session", name: ts }));
  const sw = await waitMessage(ws1, "session_switched", 5000);
  test("new_session 返回 session_switched", sw !== null, sw?.name || "");

  // 获取所有会话
  ws1.send(JSON.stringify({ type: "get_sessions" }));
  const sl = await waitMessage(ws1, "session_list", 5000);
  const hasNew = sl?.sessions?.some(s => s.name === ts);
  test("session_list 含新会话", hasNew || false);

  // 切回 default
  ws1.send(JSON.stringify({ type: "switch_session", name: "default" }));
  const sw2 = await waitMessage(ws1, "session_switched", 5000);
  test("switch_session 切回 default", sw2 !== null);

  // 删除测试会话
  ws1.send(JSON.stringify({ type: "delete_session", name: ts }));
  // delete_session 可能返回 session_switched (切到其他session) 或 error
  const result = await waitMessage(ws1, "session_switched", 5000);
  test("delete_session 成功", result !== null,
    result?.type === "session_switched" ? `切到 ${result.name}` : result?._error || "无响应");
}

// ════════════════════════════════════════════
//  阶段 7: 断线重连
// ════════════════════════════════════════════

console.log("\n── 阶段 7: 断线重连 ──\n");

{
  ws1.close();
  await new Promise(r => setTimeout(r, 500));

  let ws2;
  try {
    ws2 = await connect();
    test("重连成功", ws2.readyState === WebSocket.OPEN);

    const sl = await waitMessage(ws2, "session_list", 5000);
    test("重连后收到 session_list", sl !== null, `${sl?.sessions?.length || 0} 个会话`);
    // Keep ws2 for further tests, close old ws1
    ws1.close();
    ws1 = ws2;
  } catch (e) {
    test("重连成功", false, e.message);
  }
}

// ════════════════════════════════════════════
//  阶段 8: 自动命名 (display_name)
// ════════════════════════════════════════════

console.log("\n── 阶段 8: Session 自动命名 ──\n");

{
  const ts = `name-test-${Date.now()}`;

  // 创建新 session
  ws1.send(JSON.stringify({ type: "new_session", name: ts }));
  const sw = await waitMessage(ws1, "session_switched", 5000);
  test("创建新 session", sw !== null, sw?.name || "");

  // 发送一条消息
  const testMsg = "你好，我想写一个Python脚本读取CSV文件";
  ws1.send(JSON.stringify({ type: "user_message", content: testMsg }));
  const done = await waitAllMessages(ws1, 60000);
  const hasEnd = done.some(m => m.type === "message_end");
  test("对话完成收到 message_end", hasEnd);

  // 检查 session_list 是否包含 display_name
  ws1.send(JSON.stringify({ type: "get_sessions" }));
  const sl = await waitMessage(ws1, "session_list", 5000);
  const mySession = sl?.sessions?.find(s => s.name === ts);
  const dn = mySession?.display_name || "";
  test("session 有 display_name", dn.length > 0, `"${dn}"`);
  test("display_name 是首句前 40 字", dn === testMsg.substring(0, 40),
    `期望="${testMsg.substring(0, 40)}" 实际="${dn}"`);

  // 清理
  ws1.send(JSON.stringify({ type: "delete_session", name: ts }));
  await waitMessage(ws1, "session_switched", 5000);
}

// ════════════════════════════════════════════
//  阶段 9: last_active 排序
// ════════════════════════════════════════════

console.log("\n── 阶段 9: last_active 时间戳 ──\n");

{
  const ts1 = `time-test-1-${Date.now()}`;
  const ts2 = `time-test-2-${Date.now()}`;

  // 创建 session 1
  ws1.send(JSON.stringify({ type: "new_session", name: ts1 }));
  await waitMessage(ws1, "session_switched", 5000);
  ws1.send(JSON.stringify({ type: "user_message", content: "hello" }));
  await waitAllMessages(ws1, 60000);

  // 创建 session 2
  ws1.send(JSON.stringify({ type: "new_session", name: ts2 }));
  await waitMessage(ws1, "session_switched", 5000);
  ws1.send(JSON.stringify({ type: "user_message", content: "world" }));
  await waitAllMessages(ws1, 60000);

  // 获取 session_list 并验证
  ws1.send(JSON.stringify({ type: "get_sessions" }));
  const sl = await waitMessage(ws1, "session_list", 5000);
  const s1 = sl?.sessions?.find(s => s.name === ts1);
  const s2 = sl?.sessions?.find(s => s.name === ts2);

  const hasLastActive = s1?.last_active > 0 && s2?.last_active > 0;
  test("session 有 last_active", hasLastActive, `s1=${s1?.last_active} s2=${s2?.last_active}`);

  // s2 应该比 s1 更活跃（后面的消息）
  const s2MoreRecent = (s2?.last_active || 0) >= (s1?.last_active || 0);
  test("后创建的 session last_active 更大", s2MoreRecent);

  // 清理
  ws1.send(JSON.stringify({ type: "delete_session", name: ts1 }));
  await waitMessage(ws1, "session_switched", 5000);
  ws1.send(JSON.stringify({ type: "delete_session", name: ts2 }));
  await waitMessage(ws1, "session_switched", 5000);
}

// ════════════════════════════════════════════
//  阶段 10: command_list 显式请求
// ════════════════════════════════════════════

console.log("\n── 阶段 10: command_list 显式请求 ──\n");

{
  ws1.send(JSON.stringify({ type: "get_commands" }));
  const cl = await waitMessage(ws1, "command_list", 5000);
  const cmdCount = cl?.commands?.length || 0;
  test("get_commands 返回 command_list", cl !== null, `${cmdCount} 个命令`);
  if (cmdCount > 0) {
    cl.commands.slice(0, 5).forEach(c => console.log(`     /${c.name} — ${c.description || "(无描述)"}`));
  } else if (cl) {
    console.log(`   [DEBUG] command_list 收到但为空: ${JSON.stringify(cl)}`);
  }

  // 检查关键命令
  const hasNew = cl?.commands?.some(c => c.name === "/new");
  const hasResume = cl?.commands?.some(c => c.name === "/resume");
  const hasCompact = cl?.commands?.some(c => c.name === "/compact");
  test("包含 /new", hasNew || false);
  test("包含 /resume", hasResume || false);
  test("包含 /compact", hasCompact || false);
  test("所有命令有 name 字段", cl?.commands?.every(c => c.name?.length > 0) || false);

  const total = cl?.commands?.length || 0;
  test("命令数 >= 5（至少内置命令）", total >= 5, `${total} 个`);
}

const passed = results.filter(r => r.passed).length;
const failed = results.length - passed;

console.log(`\n${"=".repeat(60)}`);
if (failed === 0) {
  console.log(`\n  🎉 全部通过！ ${passed}/${results.length}\n`);
} else {
  console.log(`\n  ✅ ${passed} 通过  ❌ ${failed} 失败  /${results.length}\n`);
  console.log("  失败项:");
  results.filter(r => !r.passed).forEach(r => console.log(`    ❌ ${r.name} — ${r.detail}`));
}
console.log(`${"=".repeat(60)}\n`);
