'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Admission } = require('../admission');

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

  capacityUsed() {
    // Deliberately does not count in-flight lease() calls. Admission must own
    // the pending reservation that closes the check-then-await race.
    return 0;
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

function makeFakeClock(start = 0) {
  let now = start;
  let nextTimerId = 1;
  const timers = new Map();

  const clock = () => now;
  clock.setTimeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  clock.clearTimeout = (id) => timers.delete(id);
  clock.advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;

      const [id, timer] = due;
      timers.delete(id);
      now = timer.at;
      await timer.callback();
    }
    now = target;
  };

  return clock;
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
