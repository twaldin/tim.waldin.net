'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Admission } = require('../admission');
const SessionLifecycle = require('../lifecycle');
const LifecycleFake = require('./lifecycle-fake');
const { makeFakeClock } = require('./fake-clock');

class FakeLifecycle {
  constructor({ delay = 0, failCount = 0 } = {}) {
    this.delay = delay;
    this.failCount = failCount;
    this.nextHandle = 1;
    this.outstandingLeases = 0;
    this.maxOutstandingLeases = 0;
    this.leaseCalls = [];
    this.rebindCalls = [];
    this.destroyCalls = [];
    this.events = [];
  }

  async lease(sessionId, callbacks) {
    this.leaseCalls.push({ sessionId, callbacks });
    this.events.push(`lease:${sessionId}`);
    this.outstandingLeases += 1;
    this.maxOutstandingLeases = Math.max(
      this.maxOutstandingLeases,
      this.outstandingLeases,
    );

    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }

    this.outstandingLeases -= 1;
    if (this.failCount > 0) {
      this.failCount -= 1;
      throw new Error('configured lease failure');
    }

    return { handleId: `handle-${this.nextHandle++}`, inAltScreen: false };
  }

  rebind(handleId, callbacks) {
    this.rebindCalls.push({ handleId, callbacks });
  }

  async destroy(handleId) {
    this.destroyCalls.push(handleId);
    this.events.push(`destroy:${handleId}`);
  }
}

async function untilPoolHolds(lifecycle, count) {
  const deadline = Date.now() + 1000;
  while (lifecycle.pool.length !== count) {
    if (Date.now() >= deadline) {
      throw new Error(`pool holds ${lifecycle.pool.length} containers, expected ${count}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// The production composition from SessionManager: the real Admission over the
// real SessionLifecycle, with the in-memory Docker adapter underneath.
async function productionComposition({ clock } = {}) {
  const docker = new LifecycleFake();
  const lifecycle = new SessionLifecycle({ docker, poolSize: 5 });
  const admission = new Admission({ lifecycle, maxSessions: 40, ...(clock && { clock }) });
  await untilPoolHolds(lifecycle, 5);
  return { docker, lifecycle, admission };
}

/** Connect `count` visitors from distinct IPs (203.0.113.1, .2, …), one after another. */
async function admitVisitors(admission, count, { persistent = false } = {}) {
  const results = [];
  for (let visitor = 1; visitor <= count; visitor += 1) {
    const options = persistent ? { persistentId: `browser-${visitor}` } : {};
    results.push(await admission.tryAcquire(`203.0.113.${visitor}`, options));
  }
  return results;
}

test('atomically reserves at most 40 slots across a slow 60-request burst', async () => {
  const lifecycle = new FakeLifecycle({ delay: 20 });
  const admission = new Admission({ lifecycle, maxSessions: 40 });

  const results = await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      admission.tryAcquire(`198.51.100.${index}`, {})),
  );

  assert.equal(results.filter(({ mode }) => mode === 'cold').length, 40);
  assert.equal(results.filter(({ mode, reason }) => mode === 'denied' && reason === 'full').length, 20);
  assert.equal(lifecycle.leaseCalls.length, 40);
  assert.equal(lifecycle.maxOutstandingLeases, 40);
});

test('rejects persistent-session restore from a different IP', async () => {
  const lifecycle = new FakeLifecycle();
  const admission = new Admission({ lifecycle });
  const first = await admission.tryAcquire('198.51.100.1', { persistentId: 'browser-session' });

  const restored = await admission.tryAcquire('203.0.113.9', { persistentId: 'browser-session' });

  assert.equal(first.mode, 'cold');
  assert.deepEqual(restored, { mode: 'denied', reason: 'ip-mismatch' });
  assert.equal(lifecycle.rebindCalls.length, 0);
  assert.equal(lifecycle.destroyCalls.length, 0);
});

test('a second acquire from one IP destroys the first before leasing the replacement', async () => {
  const lifecycle = new FakeLifecycle();
  const admission = new Admission({ lifecycle });
  const first = await admission.tryAcquire('198.51.100.20', {});

  const second = await admission.tryAcquire('198.51.100.20', {});

  assert.equal(first.mode, 'cold');
  assert.equal(second.mode, 'cold');
  assert.deepEqual(lifecycle.destroyCalls, [first.lease.handleId]);
  assert.ok(
    lifecycle.events.indexOf(`destroy:${first.lease.handleId}`)
      < lifecycle.events.indexOf(`lease:${second.lease.leaseId}`),
  );
  assert.equal(first.lease.state, 'ended');
  assert.equal(second.lease.state, 'active');
});

test('a failed lease releases its synchronous reservation', async () => {
  const lifecycle = new FakeLifecycle({ failCount: 1 });
  const admission = new Admission({ lifecycle, maxSessions: 1 });

  const denied = await admission.tryAcquire('198.51.100.30', {});
  const retried = await admission.tryAcquire('198.51.100.31', {});

  assert.deepEqual(denied, { mode: 'denied', reason: 'lease-failed' });
  assert.equal(retried.mode, 'cold');
  assert.equal(lifecycle.leaseCalls.length, 2);
});

test('zombify destroys the handle only after the 30-second grace expires', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const acquired = await admission.tryAcquire('198.51.100.40', { persistentId: 'persist-me' });

  assert.equal(admission.zombify(acquired.lease.leaseId), true);
  assert.equal(acquired.lease.state, 'zombie');
  await clock.advance(29_999);
  assert.deepEqual(lifecycle.destroyCalls, []);

  await clock.advance(1);
  assert.deepEqual(lifecycle.destroyCalls, [acquired.lease.handleId]);
  assert.equal(acquired.lease.state, 'ended');
});

test('same-IP zombie restore cancels grace destruction and rebinds the handle', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const acquired = await admission.tryAcquire('198.51.100.41', { persistentId: 'restore-me' });
  admission.zombify(acquired.lease.leaseId);

  const restored = await admission.tryAcquire('198.51.100.41', { persistentId: 'restore-me' });
  await clock.advance(30_000);

  assert.equal(restored.mode, 'resume');
  assert.equal(restored.lease, acquired.lease);
  assert.equal(restored.lease.state, 'active');
  assert.deepEqual(lifecycle.rebindCalls.map(({ handleId }) => handleId), [acquired.lease.handleId]);
  assert.deepEqual(lifecycle.destroyCalls, []);
});

test('restore rebinds the stream to the NEW connection sinks (regression: stale-sink reattach bug)', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  let aCalls = 0;
  let bCalls = 0;
  const onOutputA = () => { aCalls += 1; };
  const onOutputB = () => { bCalls += 1; };

  const acquired = await admission.tryAcquire('203.0.113.7', { persistentId: 'pid', onOutput: onOutputA, onClose: () => {} });
  admission.zombify(acquired.lease.leaseId);

  const restored = await admission.tryAcquire('203.0.113.7', { persistentId: 'pid', onOutput: onOutputB, onClose: () => {} });
  assert.equal(restored.mode, 'resume');

  const rebind = lifecycle.rebindCalls[lifecycle.rebindCalls.length - 1];
  assert.equal(rebind.callbacks.onOutput, onOutputB, 'rebind must use the NEW socket output sink');
  rebind.callbacks.onOutput('x');
  assert.equal(bCalls, 1, 'output must reach the new sink');
  assert.equal(aCalls, 0, 'the stale (previous) sink must never receive output after reattach');
});

test('connection rate limit allows 30 attempts per rolling minute then locks', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock(10_000);
  const admission = new Admission({ lifecycle, clock });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.equal(admission.checkConnectionRate('192.0.2.1'), true);
  }
  assert.equal(admission.checkConnectionRate('192.0.2.1'), false);

  await clock.advance(59_999);
  assert.equal(admission.checkConnectionRate('192.0.2.1'), false);
  await clock.advance(1);
  assert.equal(admission.checkConnectionRate('192.0.2.1'), true);
});

test('admits 40 visitors beside the production warm pool and denies the 41st', async () => {
  const { lifecycle, admission } = await productionComposition();

  const results = await admitVisitors(admission, 41);

  assert.deepEqual(results.slice(0, 40).map(({ mode }) => mode), Array(40).fill('cold'));
  assert.deepEqual(results[40], { mode: 'denied', reason: 'full' });
  assert.equal(lifecycle.handles.size, 40);
  await untilPoolHolds(lifecycle, 5);

  await admission.destroy(results[0].lease.leaseId);
  assert.equal((await admission.tryAcquire('203.0.113.41', {})).mode, 'cold');
  assert.deepEqual(await admission.tryAcquire('203.0.113.42', {}), { mode: 'denied', reason: 'full' });
});

test('a 60-connection burst against the real lifecycle admits exactly 40', async () => {
  const { lifecycle, admission } = await productionComposition();

  const results = await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      admission.tryAcquire(`198.51.100.${index}`, {})),
  );

  assert.equal(results.filter(({ mode }) => mode === 'cold').length, 40);
  assert.equal(results.filter(({ mode, reason }) => mode === 'denied' && reason === 'full').length, 20);
  assert.equal(lifecycle.handles.size, 40);
});

test('a same-IP reconnect without a sessionId replaces its own session at capacity', async () => {
  const { lifecycle, admission } = await productionComposition();
  const visitors = await admitVisitors(admission, 40);

  const replacement = await admission.tryAcquire('203.0.113.1', {});

  assert.equal(replacement.mode, 'cold');
  assert.equal(visitors[0].lease.state, 'ended');
  assert.equal(lifecycle.handles.size, 40);
  assert.deepEqual(await admission.tryAcquire('203.0.113.41', {}), { mode: 'denied', reason: 'full' });
});

test('a same-IP connection superseded while it evicts never leases a container', async () => {
  const { docker, lifecycle, admission } = await productionComposition();
  const first = await admission.tryAcquire('203.0.113.1', {});

  const [second, third] = await Promise.all([
    admission.tryAcquire('203.0.113.1', {}),
    admission.tryAcquire('203.0.113.1', {}),
  ]);

  assert.deepEqual(second, { mode: 'denied', reason: 'cancelled' });
  assert.equal(third.mode, 'cold');
  assert.equal(lifecycle.handles.size, 1);
  assert.deepEqual(docker.removedIds, [first.lease.handleId]);
});

test('a disconnected session keeps its slot through the grace window and restores at capacity', async () => {
  const clock = makeFakeClock();
  const { lifecycle, admission } = await productionComposition({ clock });
  const visitors = await admitVisitors(admission, 40, { persistent: true });
  const { lease } = visitors[0];

  assert.equal(admission.zombify(lease.leaseId), true);
  assert.equal(lifecycle.handles.size, 40);
  assert.deepEqual(await admission.tryAcquire('203.0.113.41', {}), { mode: 'denied', reason: 'full' });

  const restored = await admission.tryAcquire('203.0.113.1', { persistentId: 'browser-1' });
  assert.equal(restored.mode, 'resume');
  assert.equal(restored.lease, lease);
  assert.equal(lifecycle.handles.size, 40);

  admission.zombify(lease.leaseId);
  await clock.advance(30_000);
  assert.equal(lease.state, 'ended');
  assert.equal(lifecycle.handles.size, 39);
  assert.equal((await admission.tryAcquire('203.0.113.41', {})).mode, 'cold');
});
