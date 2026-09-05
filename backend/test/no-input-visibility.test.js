'use strict';
// Visibility-aware no-input bot-kill timer — now tested through the SessionManager
// controller (the timer logic moved out of the old god-module). Fakes for the
// lifecycle + admission seams; no Docker, no sockets. Scaled-down windows:
// 60ms strict, 300ms visible. Run: node backend/test/no-input-visibility.test.js
const assert = require('assert');

let passed = 0;
function ok(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`ok  ${label}`); passed++; })
    .catch((e) => { console.error(`NOT OK ${label}: ${e.message}`); process.exitCode = 1; });
}

const SessionManager = require('../session.js');

function makeManager() {
  const destroyed = [];
  const admission = {
    checkConnectionRate: () => true,
    tryAcquire: async () => ({ mode: 'cold', lease: { leaseId: 'L', handleId: 'H' } }),
    zombify: async () => true,
    destroy: async (id) => { destroyed.push(id); return true; },
    pruneStaleRateLimits: () => {},
  };
  const lifecycle = {
    reclaimOrphans: async () => {},
    write: () => {},
    resize: async () => {},
    destroy: async () => true,
  };
  const mgr = new SessionManager({ lifecycle, admission });
  mgr.noInputTimeout = 60;          // 60ms stands in for 60s
  mgr.noInputTimeoutVisible = 300;  // 300ms stands in for 300s
  mgr.destroyed = destroyed;
  return mgr;
}

// Seed a controller conn state (the fields the timer path reads) and arm the timer.
function seedConn(mgr, sid, { pageVisible = undefined, hasReceivedInput = false } = {}) {
  mgr.conns.set(sid, {
    socket: { emit() {}, disconnect() {} },
    ip: '1.2.3.4',
    lease: { leaseId: `L-${sid}`, handleId: `H-${sid}` },
    initCommand: undefined,
    promptSeen: true,
    firstResizeApplied: true,
    initCommandRun: true,
    hasReceivedInput,
    pageVisible,
    pendingResize: null,
    pendingHidden: undefined,
    timeout: null,
    noInputTimer: null,
    resizeFallback: null,
  });
  mgr._setNoInputTimeout(sid);
  return mgr.conns.get(sid);
}

const killed = (mgr, sid) => mgr.destroyed.includes(`L-${sid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Case 1: no visibility report ever → killed at the strict window.
  await ok('no report → killed at strict window', async () => {
    const mgr = makeManager();
    seedConn(mgr, 's1');              // pageVisible undefined → strict (60ms)
    await sleep(140);
    assert.ok(killed(mgr, 's1'), 'should be killed at strict window');
  });

  // Case 2: visible report → alive past strict, killed at the long window.
  await ok('visible → killed at long window only', async () => {
    const mgr = makeManager();
    seedConn(mgr, 's2');
    mgr.handleVisibility('s2', false);   // hidden=false → visible
    await sleep(140);                    // past strict window
    assert.ok(!killed(mgr, 's2'), 'should survive the strict window when visible');
    await sleep(220);                    // past the long (300ms) window
    assert.ok(killed(mgr, 's2'), 'should be killed at the long window');
  });

  // Case 3: hidden report → strict window still applies.
  await ok('hidden → strict window applies', async () => {
    const mgr = makeManager();
    seedConn(mgr, 's3');
    mgr.handleVisibility('s3', true);    // hidden=true
    await sleep(140);
    assert.ok(killed(mgr, 's3'), 'hidden page should be killed at the strict window');
  });

  // Case 4: visible → hidden flip re-arms the strict window.
  await ok('visible→hidden flip re-arms strict window', async () => {
    const mgr = makeManager();
    seedConn(mgr, 's4');
    mgr.handleVisibility('s4', false);   // visible
    await sleep(150);                    // alive mid-long-window
    assert.ok(!killed(mgr, 's4'));
    mgr.handleVisibility('s4', true);    // flip to hidden → re-arm strict
    await sleep(140);
    assert.ok(killed(mgr, 's4'), 'should be killed shortly after flipping to hidden');
  });

  // Case 5: input cancels the no-input timer; later flips never re-arm it.
  await ok('input cancels timer; flips never re-arm', async () => {
    const mgr = makeManager();
    const s = seedConn(mgr, 's5');
    // Simulate "first input received" without arming the (unrelated) idle timer.
    s.hasReceivedInput = true;
    if (s.noInputTimer) { clearTimeout(s.noInputTimer); s.noInputTimer = null; }
    mgr.handleVisibility('s5', false);
    mgr.handleVisibility('s5', true);   // flips must not re-arm after input
    await sleep(400);                   // well past both windows
    assert.ok(!killed(mgr, 's5'), 'engaged session must not be bot-killed');
  });
  // Case 6: visibility report before the lease exists is buffered (no kill).
  await ok('report before lease is buffered', async () => {
    const mgr = makeManager();
    mgr.conns.set('s6', {            // conn exists but lease not yet assigned
      socket: { emit() {}, disconnect() {} }, ip: '1.2.3.4', lease: null,
      pageVisible: undefined, hasReceivedInput: false, pendingHidden: undefined,
      noInputTimer: null, timeout: null, resizeFallback: null,
    });
    mgr.handleVisibility('s6', false);   // should buffer, not arm a timer
    await sleep(140);
    assert.ok(!killed(mgr, 's6'), 'no timer should be armed before the lease exists');
  });

  console.log(`\n${passed} tests passed.`);
})();
