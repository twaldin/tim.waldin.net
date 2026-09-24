'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Admission } = require('../admission');
const SessionLifecycle = require('../lifecycle');
const SessionManager = require('../session');
const { makeFakeClock } = require('./fake-clock');
const LifecycleFake = require('./lifecycle-fake');

const MAX_WRITABLE_BYTES = 1024 * 1024 * 1024;

async function waitFor(predicate, message) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function socket(id, ip) {
  const emitted = [];
  return {
    id,
    handshake: { headers: { 'x-real-ip': ip }, auth: { initCommand: '' } },
    emit(event, payload) { emitted.push({ event, payload }); },
    disconnect() { this.disconnected = true; },
    emitted,
    disconnected: false,
  };
}

function harness(poolSize = 0) {
  const docker = new LifecycleFake();
  const lifecycle = new SessionLifecycle({ docker, poolSize });
  const clock = makeFakeClock();
  const admission = new Admission({ lifecycle, clock, maxSessions: 10 });
  const manager = new SessionManager({ lifecycle, admission });
  manager.sessionTimeout = 60_000_000;
  manager.noInputTimeout = 60_000_000;
  manager.noInputTimeoutVisible = 60_000_000;
  return { docker, lifecycle, admission, manager };
}

test('oversized active lease is ended with a message and disconnect', async () => {
  const { docker, admission, manager } = harness();
  const client = socket('active', '203.0.113.1');
  await manager.handleConnect(client);
  const { lease } = manager.conns.get(client.id);
  docker.writableSizes.set(lease.handleId, MAX_WRITABLE_BYTES + 1);

  await manager._sweepDiskUsage();

  assert.equal(admission.activeLeases.has(lease.leaseId), false);
  assert.equal(manager.conns.has(client.id), false);
  assert.equal(client.disconnected, true);
  assert.ok(client.emitted.some(({ event, payload }) =>
    event === 'output' && payload.includes('disk usage over 1 GB')));
  assert.ok(docker.removedIds.includes(lease.handleId));
});

test('oversized zombie lease is destroyed during reconnect grace', async () => {
  const { docker, admission, manager } = harness();
  const client = socket('zombie', '203.0.113.2');
  await manager.handleConnect(client);
  const { lease } = manager.conns.get(client.id);
  manager.handleDisconnect(client.id);
  docker.writableSizes.set(lease.handleId, MAX_WRITABLE_BYTES + 1);

  await manager._sweepDiskUsage();

  assert.equal(admission.zombieLeases.has(lease.leaseId), false);
  assert.ok(docker.removedIds.includes(lease.handleId));
});

test('under-limit lease stays active and warm pool containers are not inspected', async () => {
  const { docker, lifecycle, admission, manager } = harness(1);
  await waitFor(() => lifecycle.pool.length === 1, 'initial pool did not warm');
  const client = socket('under-limit', '203.0.113.3');
  await manager.handleConnect(client);
  await waitFor(() => lifecycle.pool.length === 1, 'pool did not refill');
  const { lease } = manager.conns.get(client.id);
  const poolIds = lifecycle.pool.map(({ id }) => id);
  docker.writableSizes.set(lease.handleId, MAX_WRITABLE_BYTES);
  for (const id of poolIds) docker.writableSizes.set(id, MAX_WRITABLE_BYTES + 1);

  await manager._sweepDiskUsage();

  assert.equal(admission.activeLeases.has(lease.leaseId), true);
  assert.deepEqual(docker.inspectCalls, [lease.handleId]);
  for (const id of poolIds) assert.ok(!docker.removedIds.includes(id));
  await manager.destroyAllSessions();
});

test('one failed inspect does not stop the rest of the sweep', async () => {
  const { docker, admission, manager } = harness();
  const first = socket('inspect-fails', '203.0.113.4');
  const second = socket('still-checked', '203.0.113.5');
  await manager.handleConnect(first);
  await manager.handleConnect(second);
  const firstLease = manager.conns.get(first.id).lease;
  const secondLease = manager.conns.get(second.id).lease;
  docker.inspectErrors.set(firstLease.handleId, new Error('inspect unavailable'));
  docker.writableSizes.set(secondLease.handleId, MAX_WRITABLE_BYTES + 1);

  await manager._sweepDiskUsage();

  assert.equal(admission.activeLeases.has(firstLease.leaseId), true);
  assert.equal(admission.activeLeases.has(secondLease.leaseId), false);
  assert.equal(second.disconnected, true);
  await manager.destroyAllSessions();
});
