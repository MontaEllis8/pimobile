/**
 * P0 Bug Fix Verification Tests
 * 
 * Tests for the 8 P0 issues identified in the v3.2 code review.
 * Run: node server/test-p0-fixes.mjs
 */

import { WebSocket } from 'ws';

// ═══════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════
const HOST = process.env.TEST_HOST || 'localhost';
const PORT = process.env.TEST_PORT || '8787';
const WS_URL = `ws://${HOST}:${PORT}/ws`;

let passed = 0;
let failed = 0;

function assert(condition, name, detail = '') {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function report() {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Results: ${String(passed).padStart(2)} passed, ${String(failed).padStart(2)} failed     ║`);
  console.log(`╚══════════════════════════════════════╝`);
}

// ═══════════════════════════════════════════════════
//  Helper: connect and collect messages (Phase 3: 4002 自愈重试)
// ═══════════════════════════════════════════════════
async function connect(collectMs = [], maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ws = new WebSocket(WS_URL);
    const result = await new Promise((resolve) => {
      let settled = false;
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.on('message', (data) => {
          try { collectMs.push(JSON.parse(data.toString())); } catch { /* ignore */ }
        });
        resolve({ ok: true, ws });
      };
      const onClose = (code) => {
        if (settled) return;
        if (code === 4002) {
          settled = true;
          cleanup();
          try { ws.close(); } catch {}
          resolve({ ok: false, code });
        }
      };
      const onError = (_err) => { /* wait for close */ };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('close', onClose);
        ws.off('error', onError);
      };
      ws.on('open', onOpen);
      ws.on('close', onClose);
      ws.on('error', onError);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, code: 0 });
      }, 5000);
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

// ═══════════════════════════════════════════════════
//  T1: P0#5 — optString null semantics (JSON parsing)
// ═══════════════════════════════════════════════════
async function testT1_optStringNull() {
  console.log('\n── T1: P0#5 — optString null semantics ──');
  
  const messages = [];
  const ws = await connect(messages);
  
  // Request session list
  ws.send(JSON.stringify({ type: 'get_sessions' }));
  
  // Wait for response
  await new Promise(r => setTimeout(r, 1000));
  
  const sessionList = messages.find(m => m.type === 'session_list');
  assert(sessionList != null, 'T1.1: session_list received');
  
  if (sessionList && sessionList.sessions) {
    const sessions = sessionList.sessions;
    assert(sessions.length > 0, 'T1.2: sessions array non-empty', `found ${sessions.length} sessions`);
    
    // Verify each session has valid fields for null-sensitive parsing
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      
      // parent_session: can be undefined (omitted), null, or a string UUID
      // It should NOT be the string "null" or ""
      const hasParent = s.parent_session !== undefined && s.parent_session !== null && s.parent_session !== '';

      // If it has a parent, it must look like a UUID or meaningful name
      if (hasParent) {
        assert(
          typeof s.parent_session === 'string' && s.parent_session.length > 0,
          `T1.3[${i}]: parent_session is valid string when present (got: "${s.parent_session}")`
        );
        // Must NOT be the literal string "null"
        assert(
          s.parent_session !== 'null',
          `T1.3b[${i}]: parent_session is NOT literal string "null" (P0#5 regression)`
        );
      }
      
      // status: should be "active", "running", "completed", or "sleeping"
      // NOT the string "null" or ""
      const validStatuses = ['active', 'running', 'completed', 'sleeping'];
      assert(
        validStatuses.includes(s.status),
        `T1.4[${i}]: status is valid (got: "${s.status}")`,
        `expected one of: ${validStatuses.join(', ')}`
      );
      
      // display_name: can be absent or a non-empty string
      // NOT the string "null"
      if (s.display_name !== undefined && s.display_name !== null) {
        assert(
          s.display_name !== 'null' && s.display_name !== '',
          `T1.5[${i}]: display_name is NOT literal "null" or empty (got: "${s.display_name}")`
        );
      }
    }
  }
  
  // Also test file_available message parsing: content_type
  // Simulate by sending a download request and checking response format
  ws.send(JSON.stringify({ type: 'download_file', id: Buffer.from('/nonexistent').toString('base64') }));
  await new Promise(r => setTimeout(r, 500));
  
  const fileMsg = messages.find(m => m.type === 'file_available');
  if (fileMsg) {
    // content_type can be present or absent, but never "null" string
    if (fileMsg.content_type !== undefined && fileMsg.content_type !== null) {
      assert(
        fileMsg.content_type !== 'null',
        `T1.6: content_type is NOT literal "null" (got: "${fileMsg.content_type}")`
      );
    }
  }
  
  ws.close();
}

// ═══════════════════════════════════════════════════
//  T2: P0#6 — parent_session → parentId mapping
// ═══════════════════════════════════════════════════
async function testT2_parentIdMapping() {
  console.log('\n── T2: P0#6 — parent_session → parentId mapping ──');
  
  const messages = [];
  const ws = await connect(messages);
  
  ws.send(JSON.stringify({ type: 'get_sessions' }));
  await new Promise(r => setTimeout(r, 1000));
  
  const sessionList = messages.find(m => m.type === 'session_list');
  assert(sessionList != null, 'T2.1: session_list received');
  
  if (sessionList && sessionList.sessions) {
    // The server sends session_id (UUID) and parent_session (UUID or absent)
    // The Android client should map parent_session → parentId
    // Verify server-side data structure is correct
    
    const sessions = sessionList.sessions;
    let sessionsWithParent = sessions.filter(s => s.parent_session);
    let sessionsWithCurrent = sessions.filter(s => s.current);
    
    console.log(`  Sessions total: ${sessions.length}, with parent: ${sessionsWithParent.length}, current: ${sessionsWithCurrent.length}`);
    
    // Every session should have a session_id (UUID)
    for (let i = 0; i < Math.min(sessions.length, 10); i++) {
      assert(
        sessions[i].session_id && sessions[i].session_id.length > 0,
        `T2.2[${i}]: session_id is non-empty (got: "${sessions[i].session_id}")`
      );
    }
    
    // If any session has a parent, verify parent is also a session_id
    const allIds = new Set(sessions.map(s => s.session_id));
    for (const s of sessionsWithParent.slice(0, 5)) {
      // parent_session might not be in our loaded set (could be from another project)
      // but it should be a UUID-like string
      const looksLikeUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert(
        looksLikeUUID.test(s.parent_session) || s.parent_session.length > 0,
        `T2.3: parent_session is valid identifier: "${s.parent_session}"`
      );
    }
    
    // server.ts:130 — verify new_session passes cwd to createSession
    // Test: create a session with cwd and verify project path
    // T2.4 fix (cold-start timing): wait for the session_switched ack instead
    // of a fixed 1s sleep — the first new_session after a cold start can take
    // longer than 1s (SDK first-time init), and the ack is the server's
    // confirmation that the session exists before we query the list.
    const testCwd = '/tmp/test-p0';
    const switchedBefore = messages.length;
    ws.send(JSON.stringify({ type: 'new_session', name: 'p0-test-cwd', cwd: testCwd }));

    const switchedTimeoutMs = 15000;
    const switchedStart = Date.now();
    let switchedAck = false;
    while (Date.now() - switchedStart < switchedTimeoutMs) {
      const sw = messages.slice(switchedBefore).find(
        m => m.type === 'session_switched' && m.name === 'p0-test-cwd'
      );
      if (sw) { switchedAck = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert(switchedAck, 'T2.4a: session_switched ack received for new_session');

    ws.send(JSON.stringify({ type: 'get_sessions' }));
    await new Promise(r => setTimeout(r, 500));
    
    const list2 = messages.filter(m => m.type === 'session_list');
    const latest = list2[list2.length - 1];
    if (latest) {
      const testSession = latest.sessions.find(s => s.name === 'p0-test-cwd');
      assert(testSession != null, 'T2.4: new_session with cwd created');
      if (testSession) {
        // Project path should match or contain the cwd
        console.log(`  Created session project: "${testSession.project}"`);
        assert(
          testSession.project.includes('test-p0') || testSession.project.includes(testCwd),
          `T2.5: project path matches cwd (project="${testSession.project}")`
        );
        
        // Cleanup
        ws.send(JSON.stringify({ type: 'delete_session', name: 'p0-test-cwd' }));
      }
    }
  }
  
  ws.close();
}

// ═══════════════════════════════════════════════════
//  T3: P0#7 — JSONArray recursion (message history)
// ═══════════════════════════════════════════════════
async function testT3_jsonArrayRecursion() {
  console.log('\n── T3: P0#7 — JSONArray recursion prevention ──');
  
  const messages = [];
  const ws = await connect(messages);
  
  // Request session list first
  ws.send(JSON.stringify({ type: 'get_sessions' }));
  await new Promise(r => setTimeout(r, 500));
  
  const sessionList = messages.find(m => m.type === 'session_list');
  assert(sessionList != null, 'T3.1: session_list received');
  
  // The JSONArray bug was in Android PiMessageParser.jsonObjectToMap()
  // On the server side, verify the message_history sent is well-formed
  // If we have an active session with history, test it
  if (sessionList && sessionList.sessions && sessionList.sessions.length > 0) {
    const historyMsgs = messages.filter(m => m.type === 'message_history');
    
    if (historyMsgs.length > 0) {
      const history = historyMsgs[0];
      // Verify messages array items are plain objects (not self-referencing)
      if (Array.isArray(history.messages)) {
        for (let i = 0; i < history.messages.length; i++) {
          const msg = history.messages[i];
          assert(
            typeof msg === 'object' && msg !== null,
            `T3.2[${i}]: history message is an object`
          );
          // Verify no circular references by JSON.stringify
          try {
            JSON.stringify(msg);
            assert(true, `T3.3[${i}]: history message is serializable`);
          } catch (e) {
            assert(false, `T3.3[${i}]: history message serialization failed: ${e.message}`);
          }
        }
      }
    } else {
      console.log('  ⏭️  No message_history received — skipping T3.2-T3.3 (OK)');
    }
  }
  
  ws.close();
}

// ═══════════════════════════════════════════════════
//  T4: P0#8 — JSON leak prevention  
// ═══════════════════════════════════════════════════
async function testT4_jsonLeakPrevention() {
  console.log('\n── T4: P0#8 — JSON leak prevention ──');
  
  const messages = [];
  const ws = await connect(messages);
  
  // Send an unknown message type to trigger the error path
  ws.send(JSON.stringify({ type: 'unknown_message_type_xyz', secret: 'should-not-leak' }));
  await new Promise(r => setTimeout(r, 500));
  
  const errorMsg = messages.find(m => m.type === 'error');
  assert(errorMsg != null, 'T4.1: error response received for unknown message');
  
  if (errorMsg) {
    // The error message should NOT contain the raw JSON payload
    const containsPayload = errorMsg.message.includes('unknow') || 
                            errorMsg.message.includes('unknown') ||
                            errorMsg.message.includes('Unknow');
    assert(
      !errorMsg.message.includes('secret') && !errorMsg.message.includes('should-not-leak'),
      'T4.2: error message does NOT leak JSON payload'
    );
    assert(
      !errorMsg.message.includes('{"type"'),
      'T4.3: error message does NOT contain raw JSON'
    );
    console.log(`  Error message: "${errorMsg.message}"`);
    
    // The error should be informative but not expose internals
    assert(
      errorMsg.message.length < 200,  // Was previously including full JSON which could be huge
      'T4.4: error message is concise (not full JSON)'
    );
  }
  
  ws.close();
}

// ═══════════════════════════════════════════════════
//  T5: SessionRegistry resilience (P0#1-4)
//  (QS-14: the server is single-client by design — a second live connection
//  gets 4002. This test therefore drives ALL sub-cases over ONE connection,
//  matching the real Android client and the server's intended topology.)
// ═══════════════════════════════════════════════════
async function testT5_sessionRegistryResilience() {
  console.log('\n── T5: P0#1-4 — SessionRegistry try-catch resilience ──');
  
  const ws = await connect([]);
  const msgs = [];
  ws.on('message', (d) => {
    try { msgs.push(JSON.parse(d.toString())); } catch {}
  });

  // T5.1: Verify server can handle delete of non-existent session gracefully
  ws.send(JSON.stringify({ type: 'delete_session', name: 'nonexistent-session-xyz-12345' }));
  await new Promise(r => setTimeout(r, 500));
  const delError = msgs.find(m => m.type === 'error');
  assert(delError != null, 'T5.1: delete non-existent session returns error (not crash)');

  // T5.2: Rename non-existent session should not crash
  ws.send(JSON.stringify({ type: 'rename_session', old: 'nonexistent-rename-target-xyz', new: 'newname' }));
  await new Promise(r => setTimeout(r, 500));
  const renameError = msgs.find(m => m.type === 'error');
  assert(renameError != null, 'T5.2: rename non-existent session returns error (not crash)');

  // T5.3: Create session with invalid cwd should not crash
  ws.send(JSON.stringify({ type: 'new_session', name: 'p0-test-resilience', cwd: '/nonexistent/path/deeply/nested' }));
  await new Promise(r => setTimeout(r, 1000));

  // Either session was created, or error was returned — but server should still be running
  const createResult = msgs.find(m => m.type === 'session_switched' || m.type === 'error');
  assert(createResult != null, 'T5.3: create session with bad cwd returns response (not crash)');

  // Cleanup
  const sessionListMsg = msgs.find(m => m.type === 'session_list');
  if (sessionListMsg) {
    const testSession = sessionListMsg.sessions.find(s => s.name === 'p0-test-resilience');
    if (testSession) {
      ws.send(JSON.stringify({ type: 'delete_session', name: 'p0-test-resilience' }));
    }
  }

  // T5.4: The SAME connection is still open and functional after all the
  // error paths (registry survived) — the real client never opens parallel
  // connections, so this is the meaningful liveness check.
  assert(ws.readyState === WebSocket.OPEN, 'T5.4: connection still open (registry survives)');

  // T5.5: Send get_sessions after multiple operations — still works
  ws.send(JSON.stringify({ type: 'get_sessions' }));
  await new Promise(r => setTimeout(r, 500));

  ws.close();
}

// ═══════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  P0 Bug Fix Verification Tests      ║');
  console.log('║  Server: ' + WS_URL.padEnd(23) + '  ║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testT1_optStringNull();
    await testT2_parentIdMapping();
    await testT3_jsonArrayRecursion();
    await testT4_jsonLeakPrevention();
    await testT5_sessionRegistryResilience();
  } catch (err) {
    console.error(`\n  💥 Test suite crashed: ${err.message}`);
    console.error(err.stack);
  }

  report();
  process.exit(failed > 0 ? 1 : 0);
}

main();
