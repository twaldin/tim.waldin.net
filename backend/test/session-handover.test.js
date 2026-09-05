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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeManager(t) {
  const clock = makeFakeClock();
  const docker = new LifecycleFake();
  const lifecycle = new SessionLifecycle({ docker, poolSize: 5 });
  const admission = new Admission({ lifecycle, maxSessions: 40, clock });
  const mgr = new SessionManager({ lifecycle, admission });
  mgr.noInputTimeout = 60_000_000;
  mgr.noInputTimeoutVisible = 60_000_000;
  mgr.sessionTimeout = 60_000_000;
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
    handshake: { headers: { 'x-real-ip': '203.0.113.1' }, auth: { sessionId, initCommand: '' } },
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

test('a second same-browser tab owns the lease alone; the first tab\'s grace and idle timers cannot end it', async (t) => {
  const { clock, docker, lifecycle, mgr } = makeManager(t);

  // The first tab's idle window, scaled down (ms stand in for s); the second
  // tab connects with the default so only the first tab's timer can fire here.
  mgr.sessionTimeout = 40;
  const first = fakeSocket(mgr, 'tab-1', 'browser-a');
  await mgr.handleConnect(first);
  const { lease } = mgr.conns.get('tab-1');
  const { handleId } = lease;
  mgr.sessionTimeout = 60_000_000;

  const second = fakeSocket(mgr, 'tab-2', 'browser-a');
  await mgr.handleConnect(second);
  assert.equal(statusOf(second), 'resume');
  assert.equal(mgr.conns.get('tab-2').lease, lease);

  // The visitor closes the first tab (a no-op if the server already hung up),
  // then its 30 s reconnect grace and its idle window both pass.
  first.disconnect();
  await clock.advance(30_000);
  await sleep(120);

  assert.equal(lease.state, 'active');
  assert.ok(lifecycle.handles.has(handleId), 'the container handle must survive the first tab');
  assert.deepEqual(docker.removedIds, []);
  docker.containers.get(handleId).stream.push('still here');
  assert.ok(outputOf(second).includes('still here'), 'output must reach the second tab');
  assert.ok(!outputOf(second).includes('\r\n[session idle — closed]\r\n'));
  assert.deepEqual([...mgr.conns.keys()], ['tab-2']);

  // The first tab was told and hung up by the server, never sent session_end:
  // the client would drop the browser-wide sessionId and reconnect cold,
  // evicting the tab that just took over.
  assert.ok(outputOf(first).some((line) => line.includes('newer tab')), 'the first tab must be told');
  assert.ok(!outputOf(first).includes('still here'));
  assert.ok(!first.emitted.some(({ ev }) => ev === 'session_end'));

  // Only the second tab can end the session now.
  second.disconnect();
  assert.equal(lease.state, 'zombie');
  await clock.advance(30_000);
  assert.equal(lease.state, 'ended');
  assert.deepEqual(docker.removedIds, [handleId]);
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
