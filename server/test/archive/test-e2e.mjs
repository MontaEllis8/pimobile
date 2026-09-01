/**
 * End-to-end test for Pi Android Server v3.
 *
 * Usage:
 *   cd server && node test-e2e.mjs
 *
 * Tests:
 *   1. Server startup & health check
 *   2. WebSocket connection & auth
 *   3. Session list
 *   4. Send user message → receive streaming response
 *   5. Get models
 *   6. Abort
 */

import WebSocket from "ws";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = 18887; // Use a unique port for testing
const TEST_CWD = path.join(__dirname, "..", "..", "tmp", "test-e2e-workspace");

let serverProcess = null;
let testResults = [];

function log(emoji, msg) {
  console.log(`  ${emoji} ${msg}`);
}

function pass(test) {
  testResults.push({ test, passed: true });
  log("✅", `PASS: ${test}`);
}

function fail(test, reason) {
  testResults.push({ test, passed: false, reason });
  log("❌", `FAIL: ${test} — ${reason}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Prepare test workspace ──
async function prepareWorkspace() {
  await fs.mkdir(TEST_CWD, { recursive: true });
  // Create a .gitignore so pi doesn't complain
  await fs.writeFile(path.join(TEST_CWD, ".gitignore"), "node_modules/\n");
  log("📁", `Test workspace: ${TEST_CWD}`);
}

// ── Test 1: Server startup ──
async function testServerStartup() {
  return new Promise((resolve) => {
    // Use full path to tsx
    const tsxPath = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
    const tsxCmd = process.platform === "win32" ? tsxPath + ".cmd" : tsxPath;
    const nodePath = process.execPath;

    // Use clean workspace as CWD so we don't load 26 existing sessions
    const cwd = TEST_CWD;

    serverProcess = spawn(nodePath, [tsxCmd, path.join(__dirname, "..", "src", "index.ts")], {
      cwd: cwd,
      env: { ...process.env, PORT: String(SERVER_PORT), HOST: SERVER_HOST, AUTH_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) fail("Server startup", "timeout after 15s");
      resolve();
    }, 15000);

    serverProcess.stdout.on("data", (data) => {
      const text = data.toString();
      // Server prints listening message to stdout
      if (text.includes("listening") || text.includes("SessionRegistry")) {
        if (!started) {
          started = true;
          clearTimeout(timeout);
          pass("Server startup");
          resolve();
        }
      }
    });

    serverProcess.stderr.on("data", (data) => {
      // Some log messages go to stderr
      const text = data.toString();
      if (text.includes("listening")) {
        if (!started) {
          started = true;
          clearTimeout(timeout);
          pass("Server startup");
          resolve();
        }
      }
    });

    serverProcess.on("error", (err) => {
      fail("Server startup", err.message);
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ── Test 2: Health check ──
async function testHealthCheck() {
  try {
    const res = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/health`);
    const body = await res.json();
    if (res.status === 200 && body.status === "ok") {
      pass("Health check");
    } else {
      fail("Health check", `status=${res.status} body=${JSON.stringify(body)}`);
    }
  } catch (err) {
    fail("Health check", err.message);
  }
}

// ── Test 3: WebSocket connection ──
function testWebSocketConnection() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${SERVER_HOST}:${SERVER_PORT}/ws`);

    const timeout = setTimeout(() => {
      fail("WebSocket connection", "timeout after 5s");
      resolve(null);
    }, 5000);

    ws.on("open", () => {
      clearTimeout(timeout);
      pass("WebSocket connection");
      resolve(ws);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      fail("WebSocket connection", err.message);
      resolve(null);
    });
  });
}

// ── Test 4: Receive session list ──
function testSessionList(ws) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      fail("Session list", "no session_list received in 5s");
      resolve();
    }, 5000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session_list") {
          clearTimeout(timeout);
          if (msg.sessions && msg.sessions.length > 0) {
            pass(`Session list (${msg.sessions.length} sessions)`);
          } else {
            fail("Session list", "empty session list");
          }
          resolve();
        }
      } catch (e) {
        // ignore parse errors for other messages
      }
    });

    // Request session list explicitly
    ws.send(JSON.stringify({ type: "get_sessions" }));
  });
}

// ── Test 5: Send user message & receive streaming ──
function testUserMessage(ws) {
  return new Promise((resolve) => {
    let gotTextChunk = false;
    let gotToolStart = false;
    let gotMessageEnd = false;

    const timeout = setTimeout(() => {
      if (gotTextChunk) pass("Streaming text received");
      else fail("Streaming text", "no text_chunk received");
      if (gotToolStart) pass("Tool call events");
      else log("ℹ️", "No tool calls (expected for simple messages)");
      if (gotMessageEnd) pass("Message end signal");
      else fail("Message end", "no message_end received");
      resolve();
    }, 30000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "text_chunk") gotTextChunk = true;
        if (msg.type === "tool_start") gotToolStart = true;
        if (msg.type === "message_end") gotMessageEnd = true;
        if (msg.type === "error") {
          fail("User message", msg.message);
          clearTimeout(timeout);
          resolve();
        }
      } catch (e) {
        // ignore
      }
    });

    // Send a simple prompt
    ws.send(JSON.stringify({ type: "user_message", content: "Hello! Say 'test ok' and nothing else." }));
  });
}

// ── Test 6: Get models ──
function testGetModels(ws) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      fail("Get models", "no model_list received in 5s");
      resolve();
    }, 5000);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "model_list") {
          clearTimeout(timeout);
          if (msg.models && msg.models.length > 0) {
            pass(`Model list (${msg.models.length} models)`);
          } else {
            fail("Model list", "empty");
          }
          resolve();
        }
      } catch (e) {
        // ignore
      }
    });

    ws.send(JSON.stringify({ type: "get_models" }));
  });
}

// ── Test 7: Abort ──
function testAbort(ws) {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "message_end" || msg.type === "error") {
          pass("Abort handling");
          resolve();
        }
      } catch (e) { /* ignore */ }
    });

    // Send a message then immediately abort
    ws.send(JSON.stringify({ type: "user_message", content: "Write a very long essay about the history of computing, with detailed examples and citations." }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "abort" }));
      // Give it a moment, then resolve
      setTimeout(() => resolve(), 3000);
    }, 1000);
  });
}

// ── Main test runner ──
async function main() {
  console.log("\n🧪 Pi Android Server v3 — E2E Test Suite\n");

  await prepareWorkspace();

  // Test 1: Server startup
  await testServerStartup();
  if (!testResults[0]?.passed) {
    console.log("\n❌ Server failed to start. Aborting tests.\n");
    printSummary();
    process.exit(1);
  }

  await sleep(2000); // Wait for full initialization

  // Test 2: Health check
  await testHealthCheck();

  // Test 3: WebSocket connection
  const ws = await testWebSocketConnection();
  if (!ws) {
    console.log("\n❌ WebSocket connection failed. Aborting tests.\n");
    printSummary();
    cleanup();
    process.exit(1);
  }

  await sleep(500);

  // Test 4: Session list
  await testSessionList(ws);

  // Test 5: User message → streaming
  await testUserMessage(ws);

  await sleep(1000);

  // Test 6: Get models
  await testGetModels(ws);

  await sleep(500);

  // Test 7: Abort
  await testAbort(ws);

  // Clean up
  ws.close();
  cleanup();

  // Print summary
  printSummary();
}

function printSummary() {
  const passed = testResults.filter((t) => t.passed).length;
  const failed = testResults.filter((t) => !t.passed).length;
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${testResults.length} total`);
  console.log(`${"=".repeat(40)}\n`);

  if (failed > 0) {
    console.log("Failures:");
    testResults.filter((t) => !t.passed).forEach((t) => {
      console.log(`  ❌ ${t.test}: ${t.reason}`);
    });
    console.log();
  }
}

function cleanup() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(0); });

main().catch((err) => {
  console.error("Test suite error:", err);
  cleanup();
  process.exit(1);
});
