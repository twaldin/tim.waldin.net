'use strict';
// Controller integration test — drives SessionManager through the real
// handleConnect/handleInput/handleResize/handleDisconnect seams with faithful
// fakes for lifecycle + admission. Guards the wiring that the unit suites for
// those modules don't cover (e.g. admission.zombify is synchronous — must not
// be .catch()'d). Run: node backend/test/session-controller.test.js
const assert = require('assert');

let passed = 0;
function ok(label, fn) {
  try { fn(); console.log(`ok  ${label}`); passed++; }
  catch (e) { console.error(`NOT OK ${label}: ${e.message}`); process.exitCode = 1; }
}

const SessionManager = require('../session.js');

function makeFakes() {
  const calls = { zombify: [], destroy: [], write: [], resize: [] };
  const admission = {
    checkConnectionRate: () => true,
    // tryAcquire resolves a cold lease so handleConnect completes synchronously
    // enough to assert post-state in the same tick after await.
    tryAcquire: async (_ip, { onOutput } = {}) => {
      // emit nothing; just hand back a lease. Keep onOutput for realism.
      void onOutput;
      return { mode: 'cold', lease: { leaseId: 'L1', handleId: 'H1' } };
    },
    zombify: (leaseId) => { calls.zombify.push(leaseId); return true; }, // SYNC boolean
    destroy: async (leaseId) => { calls.destroy.push(leaseId); return true; },
    pruneStaleRateLimits: () => {},
  };
  const lifecycle = {
    capacityUsed: () => 0, reclaimOrphans: async () => {},
    write: (id, d) => { calls.write.push([id, d]); },
    resize: async (id, c, r) => { calls.resize.push([id, c, r]); },
    destroy: async () => true,
  };
  return { admission, lifecycle, calls };
}

function fakeSocket(id) {
  const emitted = [];
  return {
    id,
    handshake: { headers: { 'x-real-ip': '9.9.9.9' }, auth: { initCommand: '' } },
    emit: (ev, payload) => emitted.push({ ev, payload }),
    disconnect: () => {},
    _emitted: emitted,
  };
}

(async () => {
  const { admission, lifecycle, calls } = makeFakes();
  const mgr = new SessionManager({ lifecycle, admission });
  mgr.noInputTimeout = 60_000_000;   // effectively never fire during this test
  mgr.sessionTimeout = 60_000_000;

  const socket = fakeSocket('sock-1');
  await mgr.handleConnect(socket);

  ok('handleConnect emits session_status cold', () => {
    const s = socket._emitted.find((e) => e.ev === 'session_status');
    assert.ok(s && s.payload.mode === 'cold', 'expected cold session_status');
  });

  ok('handleConnect registers the conn', () => {
    assert.ok(mgr.conns.has('sock-1'));
  });

  ok('handleInput forwards to lifecycle.write', () => {
    mgr.handleInput('sock-1', 'hi');
    assert.ok(calls.write.some(([id, d]) => id === 'H1' && d === 'hi'));
  });

  ok('handleResize forwards bounded dims to lifecycle.resize', () => {
    mgr.handleResize('sock-1', 9999, 0);   // out of bounds
    const last = calls.resize[calls.resize.length - 1];
    assert.ok(last[0] === 'H1' && last[1] <= 500 && last[2] >= 2);
  });

  ok('handleDisconnect zombifies (sync) without throwing', () => {
    assert.doesNotThrow(() => mgr.handleDisconnect('sock-1'));
    assert.deepEqual(calls.zombify, ['L1']);
    assert.ok(!mgr.conns.has('sock-1'), 'conn should be cleared');
  });

  ok('rate-limited IP is denied + disconnected', async () => {
    const a2 = { ...admission, checkConnectionRate: () => false };
    const mgr2 = new SessionManager({ lifecycle, admission: a2 });
    mgr2.noInputTimeout = 60_000_000; mgr2.sessionTimeout = 60_000_000;
    const s = fakeSocket('sock-2');
    let disconnected = false; s.disconnect = () => { disconnected = true; };
    await mgr2.handleConnect(s);
    assert.ok(disconnected, 'rate-limited connection should disconnect');
    assert.ok(!mgr2.conns.has('sock-2'));
  });

  // Clear the long timers so the process can exit.
  for (const s of mgr.conns.values()) mgr._clearTimers(s);

  console.log(`\n${passed} tests passed.`);
})();
