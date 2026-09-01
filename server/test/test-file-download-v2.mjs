/**
 * 文件下载端到端测试 v2（QS-08 修订版 + Phase 3 韧性增强）
 * 正确的协议流程: write 工具完成 → server 注册 file id → Android 直接 HTTP GET /files/:id
 * 4002 退避重试已对齐 Android 端 63ca657
 */
import WebSocket from "ws";

const HOST = process.env.TEST_HOST || "127.0.0.1";
const WS_URL = `ws://${HOST}:8787/ws`;
const DOWNLOAD_URL = `http://${HOST}:8787/files`;

let passed = 0;
let failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else     { failed++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

function listen(ws, timeout = 120000) {
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

// Phase 3: 4002 自愈重试 (对齐 Android 63ca657，退避 500ms~1500ms，2~3次)
async function connectWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ws, ok: true });
      };
      const onClose = (code) => {
        if (settled) return;
        if (code === 4002) {
          settled = true;
          cleanup();
          // Ensure ws is closed
          try { ws.close(); } catch {}
          resolve({ ws: null, ok: false, code });
        }
      };
      const onError = () => {
        // error may precede close for 4002, wait for close handler
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("close", onClose);
        ws.off("error", onError);
      };
      ws.on("open", onOpen);
      ws.on("close", onClose);
      ws.on("error", onError);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ws: null, ok: false, code: 0 });
      }, 5000);
    });

    if (result.ok && result.ws) {
      if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`);
      return result.ws;
    }

    if (result.code === 4002 && attempt < maxRetries) {
      const delay = 500 + Math.random() * 1000;
      console.log(`  ⚠️  收到 4002 (单客户端独占) — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    if (attempt >= maxRetries) {
      throw new Error(`WebSocket connect failed after ${maxRetries} attempts (last code=${result.code})`);
    }
  }
  throw new Error("connectWithRetry exhausted");
}

const ws = await connectWithRetry(3);

ws.on("error", (e) => { console.error("❌", e.message); process.exit(1); });

console.log("🧪 文件下载端到端测试 v2 (QS-08: HTTP-only, Phase 3 韧性)\n");
await new Promise(r => setTimeout(r, 1000));

ws.send(JSON.stringify({ type: "new_session", name: "file-v2-" + Date.now() }));
await new Promise(r => setTimeout(r, 2000));
// Phase 3: 使用有效模型，消除失效引用 ark-plan/deepseek-v4-flash → opencode-go/ox-alpha-free
ws.send(JSON.stringify({ type: "set_model", provider: "opencode-go", model: "ox-alpha-free" }));
await new Promise(r => setTimeout(r, 2000));

console.log("── Step 1: AI 创建文件 ──");
ws.send(JSON.stringify({ type: "user_message", content: "在当前目录创建一个文件 download-test.txt，内容写 SUCCESS_Pi_Mobile" }));
let msgs = await listen(ws);

const writeTool = msgs.find(m => m.type === "tool_start" && (m.tool_name === "write" || m.tool_name === "write_file"));
test("write 工具被调用", !!writeTool);

// 从 write 工具的 input 里提取文件路径
let filePath = "";
if (writeTool?.input) {
  try {
    const input = typeof writeTool.input === "string" ? JSON.parse(writeTool.input) : writeTool.input;
    filePath = input.path || input.file_path || "";
    console.log(`   📝 AI 写了文件: ${filePath}`);
  } catch {
    filePath = "";
  }
}
test("能提取到文件路径", filePath.length > 0);

if (!filePath) {
  console.log("\n   ⚠️ 跳过下载测试");
  ws.close();
  process.exit(1);
}

console.log("\n── Step 2: HTTP 下载文件 ──");
try {
  const fa = msgs.find(m => m.type === "file_available");
  test("收到 file_available（server 自动推送）", !!fa);
  if (!fa) {
    console.log("   ⚠️ 未收到 file_available，跳过 HTTP 步骤");
    ws.close();
    process.exit(1);
  }
  const fileId = fa.id;
  console.log(`   📤 GET /files/${fileId.substring(0, 30)}... (name=${fa.name}, size=${fa.size})`);
  const httpRes = await fetch(`${DOWNLOAD_URL}/${fileId}`);
  if (httpRes.ok) {
    const content = await httpRes.text();
    console.log(`   📥 下载内容: "${content.trim()}"`);
    test("HTTP 下载成功", httpRes.status === 200);
    test("内容正确", content.trim() === "SUCCESS_Pi_Mobile", `got: "${content.trim()}"`);
    test("文件名正确", fa.name === "download-test.txt", `got: ${fa.name}`);

    const disposition = httpRes.headers.get("content-disposition") || "";
    test("有 Content-Disposition", disposition.includes("download-test.txt"));

    const cacheControl = httpRes.headers.get("cache-control") || "";
    test("有 Cache-Control（QS-03）", cacheControl.includes("max-age"), `got: "${cacheControl}"`);
  } else {
    test("HTTP 下载失败", false, `status=${httpRes.status}`);
  }
} catch (e) {
  test("HTTP 下载异常", false, e.message);
}

console.log(`\n  ✅ ${passed}  ❌ ${failed}`);
ws.close();
process.exit(failed > 0 ? 1 : 0);
