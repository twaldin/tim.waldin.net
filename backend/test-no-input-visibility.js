'use strict';
// Unit tests for the visibility-aware no-input bot-kill timer — no Docker.
// The window durations are instance fields, so tests scale them down
// (60s → 60ms strict, 300s → 300ms visible) and use real timers.
// Run: node backend/test-no-input-visibility.js
const assert = require('assert');

let passed = 0;
function ok(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
    passed++;
  } catch (e) {
    console.error(`FAIL  ${label}`);
    console.error('      ' + e.message);
    process.exitCode = 1;
  }
}

const SessionManager = require('./session.js');

// Stub preloadImage on the prototype BEFORE constructing so the constructor's
// startup `preloadImage().then(fillPool)` never touches Docker or spins the
// 30s docker-wait retry loop (which would keep the process alive).
SessionManager.prototype.preloadImage = function () { return Promise.resolve(); };

function makeManager() {
  const mgr = new SessionManager();
  // Neutralize the docker client so nothing real is touched.
  mgr.docker = null;
  mgr.imagePreloaded = false;
  // Scaled-down windows: 60ms stands in for 60s, 300ms for 300s.
  mgr.noInputTimeout = 60;
  mgr.noInputTimeoutVisible = 300;
  // Record kills instead of touching containers/sockets.
  mgr.destroyed = [];
  mgr.destroySession = (sid) => {
    mgr.destroyed.push(sid);
    mgr.sessions.delete(sid);
  };
  return mgr;
}

// Minimal session shape — only the fields the no-input timer path reads.
function addSession(mgr, sid) {
  const session = {
    id: sid,
    socket: { emit() {}, disconnect() {} },
    stream: { write() {} },
    hasReceivedInput: false,
    pageVisible: undefined,
  };
  mgr.sessions.set(sid, session);
  mgr.setNoInputTimeout(sid);
  return session;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── Case 1: no visibility report ever → killed at the strict window ────────
  {
    const mgr = makeManager();
    addSession(mgr, 's1');
    await sleep(120);
    ok('case1: never-reported session killed at strict (60) window', () =>
      assert.deepStrictEqual(mgr.destroyed, ['s1']));
  }

  // ── Case 2: visible report → alive past strict window, killed at long one ──
  {
    const mgr = makeManager();
    addSession(mgr, 's2');
    mgr.setVisibility('s2', false); // hidden: false → page visible
    await sleep(120);
    ok('case2: visible session still alive past strict window', () =>
      assert.deepStrictEqual(mgr.destroyed, []));
    await sleep(280); // 400ms total > 300ms visible window
    ok('case2: visible session killed at the long (300) window', () =>
      assert.deepStrictEqual(mgr.destroyed, ['s2']));
  }

  // ── Case 3: hidden report → strict window still applies ────────────────────
  {
    const mgr = makeManager();
    addSession(mgr, 's3');
    mgr.setVisibility('s3', true); // hidden
    await sleep(120);
    ok('case3: hidden session killed at strict (60) window', () =>
      assert.deepStrictEqual(mgr.destroyed, ['s3']));
  }

  // ── Case 4: visible → hidden flip re-arms the strict window ────────────────
  {
    const mgr = makeManager();
    addSession(mgr, 's4');
    mgr.setVisibility('s4', false); // visible → 300 window armed
    await sleep(40);
    mgr.setVisibility('s4', true); // hidden → re-armed at 60
    await sleep(120);
    ok('case4: flip back to hidden kills at strict window', () =>
      assert.deepStrictEqual(mgr.destroyed, ['s4']));
  }

  // ── Case 5: input cancels the timer; later flips never re-arm it ───────────
  {
    const mgr = makeManager();
    const s = addSession(mgr, 's5');
    mgr.sendInput('s5', 'x'); // real path: sets hasReceivedInput, clears timer
    clearTimeout(s.timeout); // sendInput armed the 5-min idle timer — clear so the process can exit
    mgr.setVisibility('s5', true);
    ok('case5: visibility flip after input does not re-arm the timer', () =>
      assert.strictEqual(s.noInputTimer, null));
    await sleep(120);
    ok('case5: session survives past both windows', () =>
      assert.deepStrictEqual(mgr.destroyed, []));
  }

  // ── Case 6: report before the session exists is buffered ───────────────────
  {
    const mgr = makeManager();
    mgr.setVisibility('s6', false);
    ok('case6: early report buffered in pendingVisibility', () =>
      assert.strictEqual(mgr.pendingVisibility.get('s6'), false));
  }

  console.log(`\n${passed} tests passed.`);
})();
