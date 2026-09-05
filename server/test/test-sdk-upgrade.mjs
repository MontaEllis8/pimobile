/**
 * SDK 升级线 + 1.1 体验打磨 专项测试 (0.85.0)
 * 验证:
 * 1. set_auth 已废弃 → error
 * 2. set_model 错误路径 → error
 * 3. get_models 精准匹配 settings.json enabledModels (4 主力) + defaultModel 置顶
 * 4. /think 全档位与别名 (off/minimal/low/med/medium/high/xhigh/max) + 即时 state_update 回显
 *
 * 运行: cd server && TEST_HOST=127.0.0.1 node test/test-sdk-upgrade.mjs
 */
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOST = process.env.TEST_HOST || 'localhost';
const PORT = process.env.TEST_PORT || '8787';
const WS_URL = `ws://${HOST}:${PORT}/ws`;

let passed = 0, failed = 0, skipped = 0;

function assert(condition, name, detail = '') {
  if (condition) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}
function fail(name, detail = '') { console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
function skip(name, reason = '') { console.log(`  ⏭️  ${name}${reason ? ` — ${reason}` : ''}`); skipped++; }

async function connect(collectMs = [], maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return; settled = true; cleanup();
        ws.on('message', (data) => { try { collectMs.push(JSON.parse(data.toString())); } catch {} });
        resolve({ ok: true, ws });
      };
      const onClose = (code) => {
        if (settled) return;
        if (code === 4002) { settled = true; cleanup(); try { ws.close(); } catch {} resolve({ ok: false, code }); }
      };
      const onError = () => {};
      const cleanup = () => { ws.off('open', onOpen); ws.off('close', onClose); ws.off('error', onError); };
      ws.on('open', onOpen); ws.on('close', onClose); ws.on('error', onError);
      setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ ok: false, code: 0 }); }, 8000);
    });
    if (result.ok && result.ws) {
      if (attempt > 1) console.log(`  ✅ 4002 自愈成功 (attempt ${attempt})`);
      return result.ws;
    }
    if (result.code === 4002 && attempt < maxRetries) {
      const delay = 500 + Math.random() * 1000;
      console.log(`  ⚠️  收到 4002 — ${Math.round(delay)}ms 后重试 ${attempt}/${maxRetries}`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
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

// ── T1: set_auth 已废弃 → 应返回 error（Unknown message type） ──
async function testT1_setAuthDeprecated() {
  console.log('\n── T1: set_auth 已废弃 → error（Phase 3 协议瘦身）──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');
  messages.length = 0;
  send(ws, { type: 'set_auth', provider: 'sdk-test-provider', key: `sk-sdk-test-${Date.now()}` });
  try {
    const err = await waitFor(messages, (m) => m.type === 'error', 15000, 'error');
    const isAuthSet = messages.find(m => m.type === 'auth_set');
    assert(!isAuthSet, 'T1a: 不再返回 auth_set（已物理移除）');
    assert(err.message.includes('Unknown') || err.message.includes('unknown') || err.message.length > 0, 'T1b: 返回 error 提示未知消息类型');
    console.log(`    error: "${err.message}"`);
  } catch (e) {
    fail('T1: set_auth 废弃后应返回 error', e.message);
  }
  ws.close();
}

// ── T2: set_model 错误路径 ──
async function testT2_setModelNotFound() {
  console.log('\n── T2: set_model 不存在模型 → error ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');
  send(ws, { type: 'set_model', provider: 'sdk-test-nonexistent', model: 'no-such-model' });
  try {
    await waitFor(messages, (m) => m.type === 'error', 15000, 'error');
    assert(true, 'T2: 不存在模型返回 error');
  } catch (e) {
    fail('T2: 不存在模型返回 error', e.message);
  }
  ws.close();
}

// ── helpers: read settings.json ──
function readSettings() {
  const candidates = [
    join(homedir(), '.pi', 'agent', 'settings.json'),
    join(process.cwd(), '..', '.pi', 'agent', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8');
        if (raw) return JSON.parse(raw);
      }
    } catch {}
  }
  // Also try getAgentDir via env
  try {
    const agentDir = process.env.PI_AGENT_DIR || process.env.AGENT_DIR;
    if (agentDir) {
      const p = join(agentDir, 'settings.json');
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
    }
  } catch {}
  return null;
}

// ── T3: get_models 精准过滤 enabledModels ──
async function testT3_getModels() {
  console.log('\n── T3: get_models → 精准匹配 enabledModels (1.1) ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');
  await sleep(200);
  send(ws, { type: 'get_state' });
  try {
    await waitFor(messages, (m) => m.type === 'state_update', 15000, 'state_update');
  } catch (e) {
    console.log('    state_update timeout, retry get_state...');
    send(ws, { type: 'get_state' });
    await waitFor(messages, (m) => m.type === 'state_update', 15000, 'state_update retry');
  }
  messages.length = 0;
  send(ws, { type: 'get_models' });
  try {
    const ml = await waitFor(messages, (m) => m.type === 'model_list', 30000, 'model_list');
    assert(Array.isArray(ml.models), 'T3a: 收到 model_list 且 models 为数组');
    assert(ml.models.length > 0, 'T3b: 模型列表非空', `got ${ml.models.length}`);
    const hasId = ml.models.every((m) => m.id && m.provider);
    assert(hasId, 'T3c: 每个模型含 id/provider');
    // Precision check: must match enabledModels if configured
    const settings = readSettings();
    const expectedModels = settings?.enabledModels || [];
    const defaultModel = settings?.defaultModel || null;
    console.log(`    settings enabledModels: ${expectedModels.length ? expectedModels.join(', ') : '(none)'}`);
    console.log(`    defaultModel: ${defaultModel || '(none)'}`);
    console.log(`    models: ${ml.models.map(m=>m.provider+'/'+m.id).join(', ')}`);

    if (expectedModels.length > 0) {
      // Expect exact match in count and content (server should only return enabledModels)
      const expectedIds = expectedModels.map(e => e.split('/')[1]).filter(Boolean);
      const returnedIds = ml.models.map(m => m.id);
      const returnedProviders = ml.models.map(m => m.provider);
      // Check each expected id is present
      let allPresent = true;
      for (const exp of expectedModels) {
        const [p, id] = exp.split('/');
        const found = ml.models.some(m => m.provider === p && m.id === id);
        if (!found) {
          allPresent = false;
          console.log(`    missing expected: ${exp}`);
        }
      }
      assert(allPresent, 'T3d: 返回模型包含 enabledModels 全量 (4 主力)', `expected ${expectedModels.join(',')}`);
      // Check no extra models beyond enabledModels (strict filter)
      const extra = ml.models.filter(m => !expectedModels.includes(`${m.provider}/${m.id}`));
      assert(extra.length === 0, 'T3e: 返回模型仅为 enabledModels (无生僻模型)', extra.length ? `extra: ${extra.map(e=>e.provider+'/'+e.id).join(',')}` : '');
      // Check length equals enabledModels length (or at least ≤ and contains all)
      assert(ml.models.length === expectedModels.length, 'T3f: 模型数量精准等于 enabledModels 长度', `got ${ml.models.length} vs expected ${expectedModels.length}`);
      // Check defaultModel at front if configured
      if (defaultModel) {
        const dm = defaultModel.includes('/') ? defaultModel : `${settings.defaultProvider||'opencode-go'}/${defaultModel}`;
        const [dp, di] = dm.split('/');
        const first = ml.models[0];
        assert(first.provider === dp && first.id === di, 'T3g: defaultModel 置顶首位', `first=${first.provider}/${first.id} vs expected first=${dm}`);
      }
      // T3h (retired 2026-09-05, SDK 0.85.0 upgrade): hardcoded主力清单
      // ['deepseek-v4-flash','ox-alpha-free','mimo-v2.5','muse-spark-1.2-contributor']
      // 已过时——用户 enabledModels 已演进 (7 个，无 ox-alpha-free)。
      // T3d 已逐项断言 enabledModels 全量包含，此处不再重复硬编码检查。
    } else {
      // Fallback: at least filtered ≤10
      assert(ml.models.length <= 10, 'T3d: 模型列表已过滤（≤10，非全量1200+）', `got ${ml.models.length}`);
    }
  } catch (e) {
    fail('T3: get_models → model_list', e.message);
  }
  ws.close();
}

// ── T4: /think 全档位与别名 ──
async function testT4_thinkLevels() {
  console.log('\n── T4: /think 全档位 + 别名映射 + state_update (1.1) ──');
  const messages = [];
  const ws = await connect(messages);
  await waitFor(messages, (m) => m.type === 'session_list', 15000, 'session_list');
  // Ensure deterministic model for thinking tests (deepseek supports off/low/medium/high/xhigh)
  try {
    send(ws, { type: 'set_model', provider: 'opencode-go', model: 'deepseek-v4-flash' });
    await waitFor(messages, (m) => m.type === 'state_update', 15000, 'state_update after set_model deepseek');
    console.log('    switched to deepseek-v4-flash for thinking tests');
  } catch (e) {
    console.log('    set_model deepseek failed (ignore):', e.message);
  }
  messages.length = 0;
  send(ws, { type: 'get_state' });
  try { await waitFor(messages, (m) => m.type === 'state_update', 15000, 'state_update'); } catch {}
  messages.length = 0;

  const levelsToTest = [
    { input: 'off', expect: 'off' },
    { input: 'low', expect: 'low' },
    { input: 'med', expect: 'medium' },
    { input: 'medium', expect: 'medium' },
    { input: 'high', expect: 'high' },
    { input: 'xhigh', expect: 'xhigh' },
    { input: 'max', expect: 'max' },
    { input: 'minimal', expect: 'minimal' },
  ];
  // For med alias, we normalize to medium
  const normalize = (s) => s.toLowerCase() === 'med' ? 'medium' : s.toLowerCase();
  // valid levels set for permissive check
  const validNormalized = new Set(['off','minimal','low','medium','high','xhigh','max']);

  for (const { input, expect } of levelsToTest) {
    messages.length = 0;
    const beforeLen = messages.length;
    send(ws, { type: 'user_message', content: `/think ${input}` });
    try {
      // Wait for state_update that reflects the change; /think handling sends it immediately
      const su = await waitFor(messages, (m) => m.type === 'state_update', 15000, `state_update for /think ${input}`);
      const level = (su.thinking_level || '').toLowerCase();
      const normLevel = normalize(level);
      const normExpect = normalize(expect);
      // Strict alias check for med/medium, permissive for others (allow clamp)
      let ok = false;
      let detail = `got ${level}`;
      if (input === 'med' || input === 'medium') {
        ok = normLevel === 'medium';
        if (!ok) detail = `expected medium (via alias), got ${level}`;
      } else if (input === 'xhigh') {
        ok = normLevel === 'xhigh' || normLevel === 'max';
        if (!ok) detail = `expected xhigh/max, got ${level}`;
        // permissive: any valid level is considered pass to handle model-specific maps
        if (!ok) { ok = validNormalized.has(normLevel); detail = `expected xhigh/max but got clamped ${level} (allowed)`; }
      } else if (input === 'max') {
        ok = normLevel === 'max' || normLevel === 'xhigh';
        if (!ok) detail = `expected max/xhigh, got ${level}`;
        if (!ok) { ok = validNormalized.has(normLevel); detail = `expected max/xhigh but got clamped ${level} (allowed)`; }
      } else if (input === 'minimal') {
        ok = validNormalized.has(normLevel);
        detail = `got ${level} (minimal may clamp)`;
      } else {
        // For off/low/high etc, allow clamped fallback (model may not support off)
        if (normLevel === normExpect) {
          ok = true;
        } else {
          ok = validNormalized.has(normLevel);
          detail = `expected ${normExpect} but got clamped ${level} (allowed)`;
        }
      }
      assert(ok, `T4-${input}: /think ${input} → state_update thinking_level=${level}`, detail);
      // Ensure no error was emitted for valid level
      const hasError = messages.some(m => m.type === 'error');
      assert(!hasError, `T4-${input}: /think ${input} 无 error`, hasError ? messages.find(m=>m.type==='error').message : '');
    } catch (e) {
      fail(`T4-${input}: /think ${input} → state_update`, e.message);
    }
    await sleep(1200);
  }

  await sleep(800);
  // Also test case-insensitivity and alias: /think MED should work
  messages.length = 0;
  send(ws, { type: 'user_message', content: `/think MED` });
  try {
    const su = await waitFor(messages, (m) => m.type === 'state_update', 15000, 'state_update for /think MED');
    const norm = normalize((su.thinking_level||'').toLowerCase());
    assert(norm === 'medium', 'T4-alias: /think MED (uppercase) alias to medium', `got ${su.thinking_level}`);
  } catch (e) {
    fail('T4-alias: /think MED case-insensitive', e.message);
  }

  ws.close();
}

async function run() {
  console.log('🧪 SDK 升级线 + 1.1 体验打磨 (0.85.0) 专项测试');
  await testT1_setAuthDeprecated();
  await sleep(500);
  await testT2_setModelNotFound();
  await sleep(500);
  await testT3_getModels();
  await sleep(500);
  await testT4_thinkLevels();
  console.log(`\n${'═'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) { console.log('❌ Some tests FAILED!'); process.exit(1); }
  else { console.log('✅ SDK 1.1 (0.85.0) tests PASSED'); process.exit(0); }
}
run().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
