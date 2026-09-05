'use strict';

// Same-browser lease handover through the production composition: the real
// SessionManager over the real Admission and SessionLifecycle, with the
// in-memory Docker adapter underneath. A second tab presents the browser's
// persistent sessionId and resumes the first tab's lease; the first tab must
// lose every way of ending that lease (TWA-53).

const assert = require('node:assert/strict');
const test = require('node:test');
const SessionManager = require('../session');
const { Admission } = require('../admission');
const SessionLifecycle = require('../lifecycle');
const LifecycleFake = require('./lifecycle-fake');
const { makeFakeClock } = require('./fake-clock');

const IP = '203.0.113.1';
const FOREVER = 60_000_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeManager(t) {
  const clock = makeFakeClock();
  const docker = new LifecycleFake();
  const lifecycle = new SessionLifecycle({ docker, poolSize: 5 });
  const admission = new Admission({ lifecycle, maxSessions: 40, clock });
  const mgr = new SessionManager({ lifecycle, admission });
  mgr.sessionTimeout = FOREVER;
  mgr.noInputTimeout = FOREVER;
  mgr.noInputTimeoutVisible = FOREVER;
  t.after(() => { for (const state of mgr.conns.values()) mgr._clearTimers(state); });
  return { clock, docker, lifecycle, mgr };
}

/**
 * A socket as server.js wires it: Socket.IO raises `disconnect` synchronously
 * whether the client or the server closed the socket, and server.js routes it
 * to handleDisconnect.
 */
function fakeSocket(mgr, id, sessionId) {
  const socket = {
    id,
    connected: true,
    handshake: { headers: { 'x-real-ip': IP }, auth: { sessionId, initCommand: '' } },
    emitted: [],
    emit(ev, payload) { socket.emitted.push({ ev, payload }); },
    disconnect() {
      if (!socket.connected) return;
      socket.connected = false;
      mgr.handleDisconnect(id);
    },
  };
  return socket;
}

const statusOf = (socket) => socket.emitted.find(({ ev }) => ev === 'session_status')?.payload.mode;
const outputOf = (socket) => socket.emitted.filter(({ ev }) => ev === 'output').map(({ payload }) => payload);

/** The old tab was told and hung up by the server, and never sent session_end. */
function assertRetired(socket) {
  assert.equal(socket.connected, false, `${socket.id} must be disconnected by the server`);
  assert.ok(outputOf(socket).some((line) => line.includes('moved to a newer tab')), `${socket.id} must be told`);
  assert.ok(!socket.emitted.some(({ ev }) => ev === 'session_end'), `${socket.id} must not get session_end`);
}

test('the first tab is hung up at takeover; closing it and its 30 s grace cannot end the shared shell', async (t) => {
  const { clock, docker, lifecycle, mgr } = makeManager(t);
  const first = fakeSocket(mgr, 'tab-1', 'browser-a');
  await mgr.handleConnect(first);
  const { lease } = mgr.conns.get('tab-1');
  const { handleId } = lease;

  const second = fakeSocket(mgr, 'tab-2', 'browser-a');
  await mgr.handleConnect(second);
  assert.equal(statusOf(second), 'resume');
  assert.equal(mgr.conns.get('tab-2').lease, lease);
  assertRetired(first);
  assert.deepEqual([...mgr.conns.keys()], ['tab-2']);

  // The visitor closes the first tab (already hung up), then the reconnect
  // grace it would have started passes.
  first.disconnect();
  await clock.advance(30_000);
  assert.equal(lease.state, 'active');
  assert.ok(lifecycle.handles.has(handleId), 'the container handle must survive the first tab');
  assert.deepEqual(docker.removedIds, []);
  docker.push(handleId, 'still here');
  assert.ok(outputOf(second).includes('still here'), 'output must reach the second tab');
  assert.ok(!outputOf(first).includes('still here'));

  // Only the second tab can end the session now.
  second.disconnect();
  assert.equal(lease.state, 'zombie');
  await clock.advance(30_000);
  assert.equal(lease.state, 'ended');
  assert.deepEqual(docker.removedIds, [handleId]);
});

test('the first tab left open: its idle and no-input timers cannot end the shared shell', async (t) => {
  const { docker, lifecycle, mgr } = makeManager(t);
  // The first tab's windows, scaled down (ms stand in for s); the second tab
  // connects with the defaults so only the first tab's timers are due here.
  mgr.sessionTimeout = 40;
  mgr.noInputTimeout = 40;
  const first = fakeSocket(mgr, 'tab-1', 'browser-a');
  await mgr.handleConnect(first);
  const { lease } = mgr.conns.get('tab-1');
  const { handleId } = lease;
  mgr.sessionTimeout = FOREVER;
  mgr.noInputTimeout = FOREVER;

  const second = fakeSocket(mgr, 'tab-2', 'browser-a');
  await mgr.handleConnect(second);
  assert.equal(statusOf(second), 'resume');
  await sleep(120);

  assert.equal(lease.state, 'active');
  assert.ok(lifecycle.handles.has(handleId), 'the container handle must survive the first tab\'s timers');
  assert.deepEqual(docker.removedIds, []);
  docker.push(handleId, 'still here');
  assert.ok(outputOf(second).includes('still here'), 'output must reach the second tab');
  assert.ok(!outputOf(second).includes('\r\n[session idle — closed]\r\n'));
  assert.ok(!outputOf(first).includes('\r\n[session idle — closed]\r\n'));
  assert.deepEqual([...mgr.conns.keys()], ['tab-2']);
});

test('a refresh after the tab closed restores the zombie lease with nothing to retire', async (t) => {
  const { clock, docker, lifecycle, mgr } = makeManager(t);
  const before = fakeSocket(mgr, 'tab-1', 'browser-b');
  await mgr.handleConnect(before);
  const { lease } = mgr.conns.get('tab-1');
  before.disconnect();
  assert.equal(lease.state, 'zombie');

  const after = fakeSocket(mgr, 'tab-1-refreshed', 'browser-b');
  await mgr.handleConnect(after);
  await clock.advance(30_000);

  assert.equal(statusOf(after), 'resume');
  assert.equal(lease.state, 'active');
  assert.ok(lifecycle.handles.has(lease.handleId));
  assert.deepEqual(docker.removedIds, []);
  assert.deepEqual([...mgr.conns.keys()], ['tab-1-refreshed']);
  assert.ok(!before.emitted.some(({ ev }) => ev === 'session_end'));
});

test('two tabs restoring a zombie at once, while it evicts another browser\'s lease, leave one owner that receives output', async (t) => {
  const { docker, lifecycle, mgr } = makeManager(t);
  const closed = fakeSocket(mgr, 'tab-a1', 'browser-a');
  await mgr.handleConnect(closed);
  const { lease } = mgr.conns.get('tab-a1');
  closed.disconnect();
  assert.equal(lease.state, 'zombie');

  // Another browser on the same IP takes a lease beside the zombie.
  const other = fakeSocket(mgr, 'tab-b', 'browser-b');
  await mgr.handleConnect(other);
  const evicted = mgr.conns.get('tab-b').lease;
  assert.equal(statusOf(other), 'cold');

  // Restoring the zombie evicts that lease first; hold the eviction so a
  // second restore of the same lease completes while the first is waiting.
  let releaseEviction;
  const evicting = new Promise((resolve) => { releaseEviction = resolve; });
  const kill = docker.kill.bind(docker);
  docker.kill = async (id) => { if (id === evicted.handleId) await evicting; return kill(id); };

  const early = fakeSocket(mgr, 'tab-a2', 'browser-a');
  const late = fakeSocket(mgr, 'tab-a3', 'browser-a');
  const earlyConnect = mgr.handleConnect(early);
  await mgr.handleConnect(late);
  assert.equal(statusOf(late), 'resume');
  releaseEviction();
  await earlyConnect;
  assert.equal(statusOf(early), 'resume');

  const owners = [...mgr.conns].filter(([, state]) => state.lease === lease).map(([id]) => id);
  assert.equal(owners.length, 1, `exactly one conn may hold the lease, got ${owners}`);
  const [owner, retired] = early.id === owners[0] ? [early, late] : [late, early];
  assertRetired(retired);
  docker.push(lease.handleId, 'still here');
  assert.ok(outputOf(owner).includes('still here'), `output must reach the owning tab ${owner.id}`);
  assert.ok(!outputOf(retired).includes('still here'));
  assert.equal(lease.state, 'active');
  assert.deepEqual(docker.removedIds, [evicted.handleId]);
});
