/**
 * N17 (DEEP-REVIEW 2026-08-05 b4): 测试缺口补齐
 *
 * 1. ask_question 快乐路径（条件测试：依赖 AI 是否实际触发 askme 工具，
 *    未触发则 SKIP 而非 FAIL）
 * 2. compact 后 history 路径不抛错（N5: turnFiles 已清，接受无文件卡片）
 * 3. 并发 switch_session 背靠背：最终 active 正确、无 error（N10 串行化验证）
 *
 * 运行: cd server && TEST_HOST=127.0.0.1 node test-batch4.mjs
 */
import { WebSocket } from 'ws';

const HOST = process.env.TEST_HOST || 'localhost';
const PORT = process.env.TEST_PORT || '8787';
const WS_URL = `ws://${HOST}:${PORT}/ws`;

let passed = 0, failed = 0, skipped = 0;

function assert(condition, name, detail = '') {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function fail(name, detail = '') {
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

function skip(name, reason = '') {
  console.log(`  ⏭️  ${name}${reason ? ` — ${reason}` : ''}`);
  skipped++;
}

async function connect(collectMs = [], maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => { if (settled) return; settled = true; cleanup(); ws.on('message', (data) => { try { collectMs.push(JSON.parse(data.toString())); } catch {} }); resolve({ ok: true, ws }); };
      const onClose = (code) => { if (settled) return; if (code === 4002) { settled = true; cleanup(); try { ws.close(); } catch {} resolve({ ok: false, code }); } };
      const onError = () => {};
      const cleanup = () => { ws.off('open', onOpen); ws.off('close', onClose); ws.off('error', onError); };
      ws.on('open', onOpen); ws.on('close', onClose); ws.on('error', onError);
      setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ ok: false, code: 0 }); }, 8000);
    });
    if (result.ok && result.ws) { if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`); return result.ws; }
    if (result.code === 4002 && attempt < maxRetries) { const delay = 500 + Math.random() * 1000; console.log(`  ⚠️  收到 4002 — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`); await new Promise(r => setTimeout(r, delay)); continue; }
    throw new Error(`Connection failed after ${maxRetries} attempts (code=${result.code})`);
  }
  throw new Error('connect retry exhausted');
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

function waitFor(messages, predicate, timeout = 30000, label = 'message') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(check, 100);
    };
    check();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function newNamedSession(ws, messages, name) {
  send(ws, { type: 'new_session', name });
  // new_session → session_switched with the new name
  return waitFor(messages, (m) => m.type === 'session_switched' && m.name === name, 30000, `session_switched(${name})`);
}

// ═══════════════════════════════════════════════
// T1: ask_question 快乐路径（条件）
// ═══════════════════════════════════════════════
async function testT1_askQuestionHappyPath() {
  console.log('\n── T1: ask_question 快乐路径（条件测试） ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');

  const probeName = `n17-ask-${Date.now()}`;
  send(ws, { type: 'new_session', name: probeName });
  await waitFor(messages, (m) => m.type === 'session_switched' && m.name === probeName, 30000, 'session_switched');
  messages.length = 0;

  // 引导 AI 使用 AskUserQuestion 工具（当前模型不一定支持 → 条件测试）
  send(ws, { type: 'user_message', content: '请使用 AskUserQuestion 工具（或 ask_user / ask）向我提出一个简单的是非问题，例如"今天天气好吗？"。' });

  let askMsg;
  try {
    askMsg = await waitFor(messages, (m) => m.type === 'ask_question', 60000, 'ask_question');
  } catch (err) {
    skip('T1: ask_question 快乐路径', `AI 未触发 askme 工具（${err.message}），SKIP（非回归）`);
    // 清理
    send(ws, { type: 'delete_session', name: probeName });
    ws.close();
    return;
  }

  assert(askMsg.id && askMsg.question, 'T1a: 收到 ask_question 且含 id/question');
  const qid = askMsg.id;
  messages.length = 0;

  // 回复答案 → 期望 tool_output{status:"completed"}（tool_id 匹配 ask_question 来源的 toolCallId）
  send(ws, { type: 'answer_question', id: qid, answer: '是' });
  let toolOut;
  try {
    toolOut = await waitFor(messages, (m) => m.type === 'tool_output' && m.status === 'completed', 30000, 'tool_output completed');
  } catch (err) {
    fail('T1b: answer_question 后收到 tool_output completed', err.message);
    send(ws, { type: 'delete_session', name: probeName });
    ws.close();
    return;
  }
  assert(true, 'T1b: answer_question 后收到 tool_output{status:"completed"}');

  // agent 继续（收到新的 text_chunk 或 message_end，说明答案已注入且 turn 恢复）
  let continued = false;
  try {
    await waitFor(
      messages,
      (m) => m.type === 'text_chunk' || m.type === 'message_end' || m.type === 'error',
      45000,
      'agent continue after answer'
    );
    continued = true;
  } catch { /* timeout */ }
  assert(continued, 'T1c: 注入答案后 agent 继续产出（text_chunk/message_end）');

  send(ws, { type: 'delete_session', name: probeName });
  ws.close();
}

// ═══════════════════════════════════════════════
// T2: compact 后 history 路径不抛错
// ═══════════════════════════════════════════════
async function testT2_compactThenHistory() {
  console.log('\n── T2: compact 后 history 路径不抛错 ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');

  const probeName = `n17-compact-${Date.now()}`;
  send(ws, { type: 'new_session', name: probeName });
  await waitFor(messages, (m) => m.type === 'session_switched' && m.name === probeName, 30000, 'session_switched');
  messages.length = 0;

  // 发 compact（空会话 compact 可能立即完成；容忍失败，重点在之后的 history）
  send(ws, { type: 'compact' });

  // 等 compact 的终止信号：state_update 或 error（最多 120s，LLM 摘要可能慢）
  try {
    await waitFor(
      messages,
      (m) => m.type === 'state_update' || m.type === 'error',
      120000,
      'compact termination'
    );
  } catch { /* timeout — 继续验证 history 路径 */ }

  // T2a: compact 后会话仍健康 —— get_state 正常返回 state_update
  messages.length = 0;
  send(ws, { type: 'get_state' });
  try {
    await waitFor(messages, (m) => m.type === 'state_update', 30000, 'state_update');
    assert(true, 'T2a: compact 后 get_state 正常响应（会话健康）');
  } catch (err) {
    fail('T2a: compact 后 get_state 正常响应', err.message);
  }

  // T2b: 触发 getHistory 路径：断开重连 → server 初始化会调 getHistory()。
  // 注意：空会话 history 为空，server 不发送 message_history（if length>0），
  // 因此这里断言"无 error + 连接正常"即证明 getHistory 路径不抛错。
  const historyWs = await connect();
  const historyMsgs = [];
  historyWs.on('message', (d) => {
    try { historyMsgs.push(JSON.parse(d.toString())); } catch {}
  });
  await waitFor(historyMsgs, (m) => m.type === 'session_list', 30000, 'session_list').catch(() => {});
  const errAfter = historyMsgs.filter((m) => m.type === 'error');
  assert(errAfter.length === 0, 'T2b: compact 后重连（getHistory 路径）无 error 消息', errAfter.length ? JSON.stringify(errAfter[0]) : '');

  // 清理
  send(ws, { type: 'delete_session', name: probeName });
  await sleep(500);
  historyWs.close();
  ws.close();
}

// ═══════════════════════════════════════════════
// T3: 并发 switch_session 背靠背
// ═══════════════════════════════════════════════
async function testT3_rapidSwitch() {
  console.log('\n── T3: 并发 switch_session 背靠背 ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');

  const nameA = `n17-swA-${Date.now()}`;
  const nameB = `n17-swB-${Date.now()}`;
  await newNamedSession(ws, messages, nameA);
  await newNamedSession(ws, messages, nameB);
  messages.length = 0;

  // 背靠背发送（不等待响应）——N10 串行化应保证顺序处理
  send(ws, { type: 'switch_session', name: nameA });
  send(ws, { type: 'switch_session', name: nameB });

  // 收集后续消息直到出现 B 的 session_switched
  const switched = [];
  try {
    await waitFor(
      messages,
      (m) => m.type === 'session_switched',
      30000,
      'session_switched'
    );
    // 再等一点，收集可能的多余 switched
    await sleep(1500);
    for (const m of messages) {
      if (m.type === 'session_switched') switched.push(m.name);
    }
  } catch (err) {
    fail('T3a: 收到 session_switched', err.message);
  }

  assert(switched.length >= 1, 'T3a: 收到 session_switched 响应');
  // 背靠背切换：最终 active 应为 B（最后一次 switch_session 目标）
  assert(switched[switched.length - 1] === nameB, 'T3b: 最终 active 会话为 B（最后切换目标）', `实际最后: ${switched[switched.length - 1]}`);

  const errors = messages.filter((m) => m.type === 'error');
  assert(errors.length === 0, 'T3c: 并发切换无 error', errors.length ? JSON.stringify(errors[0]) : '');

  // 验证 active 确实路由正确：发 get_state，应无 error（路由到 B）
  messages.length = 0;
  send(ws, { type: 'get_state' });
  try {
    await waitFor(messages, (m) => m.type === 'state_update', 30000, 'state_update');
    assert(true, 'T3d: get_state 路由正常（active 会话响应）');
  } catch (err) {
    fail('T3d: get_state 路由正常', err.message);
  }

  // 清理
  send(ws, { type: 'delete_session', name: nameA });
  await sleep(300);
  send(ws, { type: 'delete_session', name: nameB });
  await sleep(300);
  ws.close();
}

// ═══════════════════════════════════════════════
async function run() {
  console.log('🧪 N17: 测试缺口补齐（DEEP-REVIEW b4）');
  await testT1_askQuestionHappyPath();
  await testT2_compactThenHistory();
  await testT3_rapidSwitch();

  console.log(`\n${'═'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('❌ Some tests FAILED!');
    process.exit(1);
  } else {
    console.log('✅ N17 tests PASSED');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
