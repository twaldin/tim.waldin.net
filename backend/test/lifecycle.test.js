'use strict';

const assert = require('assert');
const SessionLifecycle = require('../lifecycle');
const LifecycleFake = require('./lifecycle-fake');
const { buildContainerSpec, labelFilter } = require('../sandbox-policy');

const PREAMBLE = '{"stream":true,"stdin":true,"stdout":true,"stderr":true,"hijack":true}';
const ALT_REPLAY = '\x1b[?1049h\x1b[2J\x1b[H';

async function waitFor(predicate, message) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

(async () => {
  await test('lease uses the shared hardened container spec', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 0 });

    const handle = await lifecycle.lease('socket-1', { onOutput() {}, onClose() {} });
    const spec = docker.createdSpecs[0];

    assert.deepStrictEqual(spec, buildContainerSpec('socket-1'));
    assert.strictEqual(spec.HostConfig.NetworkMode, 'none');
    assert.deepStrictEqual(spec.HostConfig.CapAdd, ['SETUID', 'SETGID']);
    assert.ok(!Object.prototype.hasOwnProperty.call(spec.HostConfig, 'Privileged'));
    assert.deepStrictEqual(docker.resizeCalls[0], {
      id: handle.handleId,
      dimensions: { h: 40, w: 140 },
    });
  });

  await test('reclaimOrphans is label-scoped and preserves active and foreign containers', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 0 });
    const active = await lifecycle.lease('active-session', { onOutput() {}, onClose() {} });
    docker.listPayload = [
      { Id: active.handleId, State: 'running', Labels: { app: 'terminal-portfolio' } },
      { Id: 'portfolio-orphan', State: 'exited', Labels: { app: 'terminal-portfolio' } },
      { Id: 'not-ours', State: 'exited', Labels: { app: 'some-other-app' } },
    ];

    await lifecycle.reclaimOrphans();

    assert.deepStrictEqual(docker.listCalls, [{ all: true, filters: labelFilter() }]);
    assert.deepStrictEqual(docker.removedIds, ['portfolio-orphan']);
    assert.ok(!docker.removedIds.includes('not-ours'));
    assert.ok(!docker.removedIds.includes(active.handleId));
    assert.deepStrictEqual(docker.removeCalls[0].options.filters, labelFilter());
    assert.strictEqual(docker.pruneImagesCalls.length, 0);
    assert.strictEqual(docker.pruneContainersCalls, 0);
  });

  await test('pool refills in the background after a lease', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 1 });
    await waitFor(() => lifecycle.pool.length === 1, 'initial pool did not warm');

    await lifecycle.lease('socket-from-pool', { onOutput() {}, onClose() {} });
    await waitFor(() => lifecycle.pool.length === 1, 'pool did not refill after lease');

    assert.strictEqual(docker.createdSpecs.length, 2);
    assert.strictEqual(docker.createdSpecs[0].Labels.session, 'pool');
    assert.strictEqual(docker.createdSpecs[1].Labels.session, 'pool');
  });

  await test('a failed warm releases its warming slot so the next lease refills the pool', async () => {
    const docker = new LifecycleFake();
    const create = docker.create.bind(docker);
    let failNext = true;
    docker.create = async (spec) => {
      if (failNext) {
        failNext = false;
        throw new Error('docker unavailable');
      }
      return create(spec);
    };
    const lifecycle = new SessionLifecycle({ docker, poolSize: 1 });
    await waitFor(() => lifecycle.poolWarming === 0, 'failed warm did not release its slot');
    assert.strictEqual(lifecycle.pool.length, 0);

    await lifecycle.lease('after-failed-warm', { onOutput() {}, onClose() {} });
    await waitFor(() => lifecycle.pool.length === 1, 'pool did not refill after the failed warm');

    assert.strictEqual(docker.createdSpecs.length, 2);
    assert.strictEqual(docker.createdSpecs[0].Labels.session, 'after-failed-warm');
    assert.strictEqual(docker.createdSpecs[1].Labels.session, 'pool');
  });

  await test('rebind replays alternate-screen state to the replacement sink', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 0 });
    const firstOutput = [];
    const handle = await lifecycle.lease('alt-session', {
      onOutput: (output) => firstOutput.push(output),
      onClose() {},
    });

    docker.push(handle.handleId, '\x1b[?1049h');
    assert.strictEqual(handle.inAltScreen, true);

    const reboundOutput = [];
    lifecycle.rebind(handle.handleId, {
      onOutput: (output) => reboundOutput.push(output),
      onClose() {},
    });

    assert.deepStrictEqual(reboundOutput, [ALT_REPLAY]);
  });

  await test('stream forwarding filters a split preamble and tracks alt-screen flips', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 0 });
    const output = [];
    const handle = await lifecycle.lease('stream-session', {
      onOutput: (chunk) => output.push(chunk),
      onClose() {},
    });

    docker.push(handle.handleId, PREAMBLE.slice(0, 20));
    assert.deepStrictEqual(output, []);
    docker.push(handle.handleId, PREAMBLE.slice(20) + 'ready\x1b[?47h');
    assert.deepStrictEqual(output, ['ready\x1b[?47h']);
    assert.strictEqual(handle.inAltScreen, true);

    docker.push(handle.handleId, 'done\x1b[?1049l');
    assert.deepStrictEqual(output, ['ready\x1b[?47h', 'done\x1b[?1049l']);
    assert.strictEqual(handle.inAltScreen, false);
  });

  await test('write, resize, close, and destroy delegate through the adapter', async () => {
    const docker = new LifecycleFake();
    const lifecycle = new SessionLifecycle({ docker, poolSize: 0 });
    let closeCalls = 0;
    const handle = await lifecycle.lease('operations-session', {
      onOutput() {},
      onClose: () => closeCalls++,
    });

    assert.strictEqual(lifecycle.write(handle.handleId, 'echo hello\r'), true);
    assert.deepStrictEqual(docker.streamFor(handle.handleId).writes, ['echo hello\r']);
    await lifecycle.resize(handle.handleId, 100, 30);
    assert.deepStrictEqual(docker.resizeCalls[1], {
      id: handle.handleId,
      dimensions: { h: 30, w: 100 },
    });

    docker.close(handle.handleId);
    assert.strictEqual(closeCalls, 1);
    assert.strictEqual(await lifecycle.destroy(handle.handleId), true);
    assert.strictEqual(lifecycle.handles.size, 0);
    assert.ok(docker.killedIds.includes(handle.handleId));
    assert.ok(docker.removedIds.includes(handle.handleId));
    assert.strictEqual(await lifecycle.destroy(handle.handleId), false);
  });

  console.log(`\n${passed} tests passed.`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
