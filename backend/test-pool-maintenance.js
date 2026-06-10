'use strict';
// Unit tests for the self-healing pre-warm pool control logic — no Docker.
// We stub warmOne so no real containers are created.
// Run: node backend/test-pool-maintenance.js
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

// Build a manager with warmOne stubbed BEFORE any real warming can occur.
// The constructor's preloadImage() resolves async and only fills when
// imagePreloaded is true; we control that and warmOne directly here.
function makeManager() {
  const mgr = new SessionManager();
  // Neutralize the docker client so nothing real is touched.
  mgr.docker = null;
  mgr.imagePreloaded = true;
  mgr.pool = [];
  mgr.poolWarming = 0;
  mgr._poolBackoffMs = 0;
  mgr._lastWarmFailAt = undefined;
  return mgr;
}

// Drain the microtask/timer queues so the .then/.catch/.finally on warmOne settle.
function settle() {
  return new Promise((r) => setImmediate(r));
}

// ── Case 1: fillPool schedules up to poolSize warm attempts ──────────────────
(async () => {
  await new Promise((done) => {
    const mgr = makeManager();
    let calls = 0;
    mgr.warmOne = () => {
      calls++;
      // Simulate a successful warm. The REAL warmOne only pushes to the pool
      // after async work resolves, so push asynchronously here too — otherwise
      // pool.length would grow mid-loop and short-circuit the while condition.
      return Promise.resolve().then(() => { mgr.pool.push({ alive: true }); });
    };

    mgr.fillPool();

    // poolWarming should have been incremented up to poolSize synchronously.
    ok('case1: poolWarming incremented to poolSize synchronously', () =>
      assert.strictEqual(mgr.poolWarming, mgr.poolSize));

    settle().then(() => settle()).then(() => {
      ok('case1: warmOne called poolSize times', () =>
        assert.strictEqual(calls, mgr.poolSize));
      ok('case1: poolWarming returns to 0 after settle', () =>
        assert.strictEqual(mgr.poolWarming, 0));
      ok('case1: pool is full', () =>
        assert.strictEqual(mgr.pool.length, mgr.poolSize));
      ok('case1: backoff reset to 0 on success', () =>
        assert.strictEqual(mgr._poolBackoffMs, 0));
      done();
    });
  });

  // ── Case 2: warmOne rejection → no throw, poolWarming 0, backoff grows ──────
  await new Promise((done) => {
    const mgr = makeManager();
    let calls = 0;
    mgr.warmOne = () => {
      calls++;
      return Promise.reject(new Error('getaddrinfo EAI_AGAIN socket-proxy'));
    };

    ok('case2: fillPool does not throw on rejecting warmOne', () =>
      assert.doesNotThrow(() => mgr.fillPool()));

    settle().then(() => settle()).then(() => {
      ok('case2: warmOne attempted poolSize times', () =>
        assert.strictEqual(calls, mgr.poolSize));
      ok('case2: poolWarming returns to 0', () =>
        assert.strictEqual(mgr.poolWarming, 0));
      ok('case2: _poolBackoffMs increased above 0', () =>
        assert.ok(mgr._poolBackoffMs > 0, `expected >0, got ${mgr._poolBackoffMs}`));
      ok('case2: _poolBackoffMs is capped at 30000', () =>
        assert.ok(mgr._poolBackoffMs <= 30000, `expected <=30000, got ${mgr._poolBackoffMs}`));
      ok('case2: _lastWarmFailAt recorded', () =>
        assert.strictEqual(typeof mgr._lastWarmFailAt, 'number'));
      done();
    });
  });

  // ── Case 3: startPoolMaintenance is idempotent ──────────────────────────────
  {
    const mgr = makeManager();
    mgr.warmOne = () => Promise.resolve();
    mgr.startPoolMaintenance();
    const firstTimer = mgr._poolMaintTimer;
    ok('case3: maintenance timer is set after first call', () =>
      assert.ok(firstTimer, 'expected _poolMaintTimer to be set'));
    mgr.startPoolMaintenance();
    ok('case3: second call does not create a new timer (idempotent)', () =>
      assert.strictEqual(mgr._poolMaintTimer, firstTimer));
    // Clear so the process can exit.
    clearInterval(mgr._poolMaintTimer);
  }

  console.log(`\n${passed} tests passed.`);
})();
