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

// Per-kind IP policy (TWA-114): a site connection replaces its IP's site
// lease; embeds share an IP up to four leases and never displace anything.

test('a mixed-kind burst reserves exactly maxSessions slots; a site replacement at capacity inherits the evicted slot', async () => {
  const lifecycle = new FakeLifecycle({ delay: 20 });
  const admission = new Admission({ lifecycle, maxSessions: 6 });
  const requests = [
    ['198.51.100.1', 'site'],
    ['198.51.100.2', 'embed'],
    ['198.51.100.2', 'embed'],
    ['198.51.100.3', 'site'],
    ['198.51.100.2', 'site'],
    ['198.51.100.4', 'embed'],
    ['198.51.100.5', 'site'],
    ['198.51.100.4', 'embed'],
  ];

  const results = await Promise.all(requests.map(([ip, kind]) => admission.tryAcquire(ip, { kind })));

  assert.deepEqual(
    results.map((result) => (result.mode === 'cold' ? `${result.lease.kind} ${result.lease.ip}` : result.reason)),
    [
      'site 198.51.100.1', 'embed 198.51.100.2', 'embed 198.51.100.2', 'site 198.51.100.3',
      'site 198.51.100.2', 'embed 198.51.100.4', 'full', 'full',
    ],
  );
  assert.equal(lifecycle.maxOutstandingLeases, 6);

  let releaseTeardown;
  const teardown = new Promise((resolve) => { releaseTeardown = resolve; });
  const destroy = lifecycle.destroy.bind(lifecycle);
  lifecycle.destroy = async (handleId) => { await teardown; return destroy(handleId); };
  const replacing = admission.tryAcquire('198.51.100.1', { kind: 'site' });
  const duringTeardown = await admission.tryAcquire('198.51.100.6', { kind: 'embed' });
  releaseTeardown();
  const replacement = await replacing;

  assert.deepEqual(duringTeardown, { mode: 'denied', reason: 'full' });
  assert.equal(replacement.mode, 'cold');
  assert.equal(results[0].lease.state, 'ended');
  assert.deepEqual(lifecycle.destroyCalls, [results[0].lease.handleId]);
  assert.deepEqual(await admission.tryAcquire('198.51.100.6', { kind: 'embed' }), { mode: 'denied', reason: 'full' });
});

test('a site connection replaces only its IP\'s site lease; the embed leases on that IP stay active', async () => {
  const lifecycle = new FakeLifecycle();
  const admission = new Admission({ lifecycle });
  const superseded = [];
  const acquire = (kind, name) =>
    admission.tryAcquire('198.51.100.20', { kind, onSuperseded: () => superseded.push(name) });

  const embedA = await acquire('embed', 'embed-a');
  const siteA = await acquire('site', 'site-a');
  const embedB = await acquire('embed', 'embed-b');
  const siteB = await acquire('site', 'site-b');

  assert.deepEqual(
    [embedA, siteA, embedB, siteB].map(({ lease }) => lease.state),
    ['active', 'ended', 'active', 'active'],
  );
  assert.deepEqual(superseded, ['site-a']);
  assert.deepEqual(lifecycle.destroyCalls, [siteA.lease.handleId]);
});

test('zombifying a site lease destroys only that IP\'s older site zombie, never an embed zombie', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const ip = '198.51.100.30';
  const embed = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  const olderSite = await admission.tryAcquire(ip, { kind: 'site', persistentId: 'browser-a' });
  admission.zombify(embed.lease.leaseId);
  admission.zombify(olderSite.lease.leaseId);

  const newerSite = await admission.tryAcquire(ip, { kind: 'site', persistentId: 'browser-b' });
  admission.zombify(newerSite.lease.leaseId);

  assert.deepEqual(
    [embed, olderSite, newerSite].map(({ lease }) => lease.state),
    ['zombie', 'ended', 'zombie'],
  );
  assert.deepEqual(lifecycle.destroyCalls, [olderSite.lease.handleId]);
  assert.equal((await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' })).mode, 'resume');
});

test('an IP holds at most four embed leases, pending, active and zombie alike; the fifth is denied ip-cap with global room', async () => {
  const lifecycle = new FakeLifecycle({ delay: 20 });
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock, maxSessions: 40 });
  const embed = () => admission.tryAcquire('198.51.100.40', { kind: 'embed' });
  const [zombie, active] = await Promise.all([embed(), embed()]);
  admission.zombify(zombie.lease.leaseId);
  const pending = [embed(), embed()];

  const fifth = await embed();
  const neighbour = await admission.tryAcquire('198.51.100.41', { kind: 'embed' });
  const settled = await Promise.all(pending);
  await clock.advance(30_000);
  const afterGrace = await embed();

  assert.deepEqual(fifth, { mode: 'denied', reason: 'ip-cap' });
  assert.equal(neighbour.mode, 'cold');
  assert.deepEqual(settled.map(({ mode }) => mode), ['cold', 'cold']);
  assert.equal(active.lease.state, 'active');
  assert.equal(afterGrace.mode, 'cold');
  assert.deepEqual(lifecycle.destroyCalls, [zombie.lease.handleId]);
});

test('embed acquisition, zombification and restore never evict or destroy another lease on the IP', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const ip = '198.51.100.50';
  let siteSuperseded = 0;
  const site = await admission.tryAcquire(ip, { kind: 'site', onSuperseded: () => { siteSuperseded += 1; } });
  const first = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  const second = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-2' });
  admission.zombify(first.lease.leaseId);
  admission.zombify(second.lease.leaseId);

  const restored = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  const third = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-3' });

  assert.equal(restored.mode, 'resume');
  assert.deepEqual(
    [site, first, second, third].map(({ lease }) => lease.state),
    ['active', 'active', 'zombie', 'active'],
  );
  assert.equal(siteSuperseded, 0);
  assert.deepEqual(lifecycle.destroyCalls, []);
});

test('an IP at its embed cap on a full server is denied ip-cap, not full', async () => {
  const lifecycle = new FakeLifecycle();
  const admission = new Admission({ lifecycle, maxSessions: 5 });
  for (let iframe = 1; iframe <= 4; iframe += 1) {
    await admission.tryAcquire('198.51.100.60', { kind: 'embed' });
  }
  await admission.tryAcquire('198.51.100.61', { kind: 'site' });

  assert.deepEqual(await admission.tryAcquire('198.51.100.60', { kind: 'embed' }), { mode: 'denied', reason: 'ip-cap' });
  assert.deepEqual(await admission.tryAcquire('198.51.100.62', { kind: 'embed' }), { mode: 'denied', reason: 'full' });
});

test('restore needs the same persistent id, kind and IP; the same id of another kind takes the cold path', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const embed = await admission.tryAcquire('198.51.100.70', { kind: 'embed', persistentId: 'shared-id' });
  admission.zombify(embed.lease.leaseId);

  const otherIp = await admission.tryAcquire('198.51.100.71', { kind: 'embed', persistentId: 'shared-id' });
  const otherKind = await admission.tryAcquire('198.51.100.70', { kind: 'site', persistentId: 'shared-id' });
  const same = await admission.tryAcquire('198.51.100.70', { kind: 'embed', persistentId: 'shared-id' });

  assert.deepEqual(otherIp, { mode: 'denied', reason: 'ip-mismatch' });
  assert.equal(otherKind.mode, 'cold');
  assert.equal(otherKind.lease.kind, 'site');
  assert.equal(same.mode, 'resume');
  assert.equal(same.lease, embed.lease);
  assert.deepEqual(lifecycle.rebindCalls.map(({ handleId }) => handleId), [embed.lease.handleId]);
});

test('a site zombie restore evicts the site lease its IP took meanwhile and leaves the embed lease', async () => {
  const lifecycle = new FakeLifecycle();
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock });
  const ip = '198.51.100.80';
  const superseded = [];
  const closedTab = await admission.tryAcquire(ip, { kind: 'site', persistentId: 'browser-a' });
  admission.zombify(closedTab.lease.leaseId);
  const embed = await admission.tryAcquire(ip, {
    kind: 'embed', persistentId: 'iframe-1', onSuperseded: () => superseded.push('iframe-1'),
  });
  const otherBrowser = await admission.tryAcquire(ip, {
    kind: 'site', persistentId: 'browser-b', onSuperseded: () => superseded.push('browser-b'),
  });

  const restored = await admission.tryAcquire(ip, { kind: 'site', persistentId: 'browser-a' });

  assert.equal(restored.mode, 'resume');
  assert.deepEqual(
    [closedTab, embed, otherBrowser].map(({ lease }) => lease.state),
    ['active', 'active', 'ended'],
  );
  assert.deepEqual(superseded, ['browser-b']);
  assert.deepEqual(lifecycle.destroyCalls, [otherBrowser.lease.handleId]);
});

test('an embed reconnecting while its first container is still pending takes that lease over instead of reserving a second slot', async () => {
  const lifecycle = new FakeLifecycle({ delay: 20 });
  const admission = new Admission({ lifecycle, maxSessions: 40, clock: makeFakeClock() });
  const superseded = [];
  const ip = '203.0.113.1';

  const first = admission.tryAcquire(ip, {
    kind: 'embed', persistentId: 'iframe-1', onSuperseded: () => superseded.push('first socket'),
  });
  const reconnect = admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  const [firstResult, reconnectResult] = await Promise.all([first, reconnect]);

  assert.equal(firstResult.mode, 'cold');
  assert.equal(reconnectResult.mode, 'resume');
  assert.equal(reconnectResult.lease.leaseId, firstResult.lease.leaseId);
  assert.deepEqual(superseded, ['first socket']);
  assert.equal(lifecycle.leaseCalls.length, 1);
  assert.deepEqual(lifecycle.rebindCalls.map(({ handleId }) => handleId), ['handle-1']);

  // The iframe holds one of the IP's four embed slots, not two.
  const others = await Promise.all(['iframe-2', 'iframe-3', 'iframe-4', 'iframe-5'].map((persistentId) =>
    admission.tryAcquire(ip, { kind: 'embed', persistentId })));
  assert.deepEqual(others.map(({ mode, reason }) => reason ?? mode), ['cold', 'cold', 'cold', 'ip-cap']);
});

test('after a reconnect during a pending acquisition, a later restore returns the shell the reconnect was using', async () => {
  const lifecycle = new FakeLifecycle({ delay: 20 });
  const admission = new Admission({ lifecycle, maxSessions: 40, clock: makeFakeClock() });
  const ip = '203.0.113.1';
  let firstSuperseded = false;

  const first = admission.tryAcquire(ip, {
    kind: 'embed', persistentId: 'iframe-1', onSuperseded: () => { firstSuperseded = true; },
  });
  const reconnect = admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  const [firstResult, reconnectResult] = await Promise.all([first, reconnect]);
  // As SessionManager does for a socket that left during the acquire: the
  // lease is zombified unless a later connection already took it over.
  if (!firstSuperseded) admission.zombify(firstResult.lease.leaseId);
  admission.zombify(reconnectResult.lease.leaseId);

  const restored = await admission.tryAcquire(ip, { kind: 'embed', persistentId: 'iframe-1' });
  assert.equal(restored.mode, 'resume');
  assert.equal(restored.lease.leaseId, reconnectResult.lease.leaseId);
  assert.equal(restored.lease.handleId, reconnectResult.lease.handleId);
  assert.equal(admission.leasesForMaintenance().length, 1);
});

test('a site reconnect during a held acquisition never evicts the newer connection that replaced it', async () => {
  for (const bLeaves of [false, true]) {
    const lifecycle = new FakeLifecycle();
    const lease = lifecycle.lease.bind(lifecycle);
    let releaseA;
    const heldA = new Promise((resolve) => { releaseA = resolve; });
    let leaseCalls = 0;
    lifecycle.lease = async (...args) => {
      if (leaseCalls++ === 0) await heldA;
      return lease(...args);
    };
    const admission = new Admission({ lifecycle, maxSessions: 40, clock: makeFakeClock() });
    const ip = '203.0.113.1';

    const a = admission.tryAcquire(ip, { persistentId: 'a' });
    const b = admission.tryAcquire(ip, { persistentId: 'a' });
    const c = admission.tryAcquire(ip, { persistentId: 'c' });
    releaseA();
    const [, bResult, cResult] = await Promise.all([a, b, c]);
    // As SessionManager does when a socket left during its acquire.
    if (bLeaves && bResult.mode === 'cold') admission.zombify(bResult.lease.leaseId);

    assert.equal(cResult.mode, 'cold', `bLeaves=${bLeaves}`);
    assert.equal(cResult.lease.state, 'active', `bLeaves=${bLeaves}`);
    assert.deepEqual(
      admission.leasesForMaintenance().map(({ leaseId }) => leaseId),
      [cResult.lease.leaseId],
      `bLeaves=${bLeaves}`,
    );
  }
});
