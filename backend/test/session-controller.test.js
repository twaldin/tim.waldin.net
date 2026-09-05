'use strict';
// Controller integration test — drives SessionManager through the real
// handleConnect/handleInput/handleResize/handleDisconnect seams with faithful
// fakes for lifecycle + admission. Guards the wiring that the unit suites for
// those modules don't cover (e.g. admission.zombify is synchronous — must not
// be .catch()'d). Run: node backend/test/session-controller.test.js
const assert = require('assert');

let passed = 0;
async function ok(label, fn) {
  try { await fn(); console.log(`ok  ${label}`); passed++; }
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

  await ok('handleConnect emits session_status cold', () => {
    const s = socket._emitted.find((e) => e.ev === 'session_status');
    assert.ok(s && s.payload.mode === 'cold', 'expected cold session_status');
  });

  await ok('handleConnect registers the conn', () => {
    assert.ok(mgr.conns.has('sock-1'));
  });

  await ok('handleInput forwards to lifecycle.write', () => {
    mgr.handleInput('sock-1', 'hi');
    assert.ok(calls.write.some(([id, d]) => id === 'H1' && d === 'hi'));
  });

  await ok('handleResize forwards bounded dims to lifecycle.resize', () => {
    mgr.handleResize('sock-1', 9999, 0);   // out of bounds
    const last = calls.resize[calls.resize.length - 1];
    assert.ok(last[0] === 'H1' && last[1] <= 500 && last[2] >= 2);
  });

  await ok('handleDisconnect zombifies (sync) without throwing', () => {
    assert.doesNotThrow(() => mgr.handleDisconnect('sock-1'));
    assert.deepEqual(calls.zombify, ['L1']);
    assert.ok(!mgr.conns.has('sock-1'), 'conn should be cleared');
  });

  await ok('rate-limited IP is denied + disconnected', async () => {
    const deniedAdmission = { ...admission, checkConnectionRate: () => false };
    const deniedMgr = new SessionManager({ lifecycle, admission: deniedAdmission });
    deniedMgr.noInputTimeout = 60_000_000; deniedMgr.sessionTimeout = 60_000_000;
    const s = fakeSocket('sock-2');
    let disconnected = false; s.disconnect = () => { disconnected = true; };
    await deniedMgr.handleConnect(s);
    assert.ok(disconnected, 'rate-limited connection should disconnect');
    assert.ok(!deniedMgr.conns.has('sock-2'));
  });

  await ok('handleConnect emits session_status resume and interrupts the prior script', async () => {
    const resumeAdmission = {
      ...admission,
      tryAcquire: async () => ({ mode: 'resume', lease: { leaseId: 'L3', handleId: 'H3' } }),
    };
    const resumeMgr = new SessionManager({ lifecycle, admission: resumeAdmission });
    resumeMgr.noInputTimeout = 60_000_000; resumeMgr.sessionTimeout = 60_000_000;
    const s = fakeSocket('sock-3');
    await resumeMgr.handleConnect(s);
    const status = s._emitted.find((e) => e.ev === 'session_status');
    assert.ok(status && status.payload.mode === 'resume', 'expected resume session_status');
    assert.ok(calls.write.some(([id, d]) => id === 'H3' && d === '\x03'),
      'resume should send Ctrl-C to the restored container');
    for (const c of resumeMgr.conns.values()) resumeMgr._clearTimers(c);
  });

  await ok('startPoolMaintenance arms one interval and is idempotent', () => {
    mgr.startPoolMaintenance();
    const timer = mgr._maintTimer;
    assert.ok(timer, 'expected a maintenance interval');
    mgr.startPoolMaintenance();
    assert.strictEqual(mgr._maintTimer, timer, 'second call must not replace the interval');
    clearInterval(timer);
  });

  // Clear the long timers so the process can exit.
  for (const s of mgr.conns.values()) mgr._clearTimers(s);

  console.log(`\n${passed} tests passed.`);
})();
