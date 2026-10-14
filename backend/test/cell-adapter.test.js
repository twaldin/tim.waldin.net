'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const SessionLifecycle = require('../lifecycle');
const { CellAdapter, cellPolicy, frame } = require('../cell-adapter');
const { buildContainerSpec } = require('../sandbox-policy');

const HOST = { arch: 'x64', kernel: '6.8.0-146-generic' };

function fields(policy, key) {
  return policy.filter((f) => f.startsWith(`${key}=`)).map((f) => f.slice(key.length + 1));
}

test('the cell policy carries the session container spec', () => {
  const policy = cellPolicy(buildContainerSpec('socket-1'), HOST);

  assert.deepEqual(policy.slice(0, 14), [
    'hostname=twaldin',
    'user=portfolio',
    'cwd=/home/portfolio',
    'env=TERM=xterm-256color',
    'env=PS1=tim.waldin.net:$ ',
    'env=LANG=C.UTF-8',
    'env=LC_ALL=C.UTF-8',
    'memory=536870912',
    'swap=0',
    'cpu=50000 100000',
    'pids=100',
    'rootfs=268435456',
    'cap=CAP_SETUID',
    'cap=CAP_SETGID',
  ]);
  assert.deepEqual(fields(policy, 'tmpfs'), ['/tmp:rw,noexec,nosuid,size=100m']);
  assert.deepEqual(fields(policy, 'seccomp-default'), ['errno:1']);
  assert.deepEqual(fields(policy, 'seccomp-arch'), ['x86_64', 'x86', 'x32']);
});

test('seccomp rules follow moby filtering for SETUID/SETGID on amd64', () => {
  const rules = fields(cellPolicy(buildContainerSpec('socket-1'), HOST), 'seccomp');

  assert.ok(rules.includes('errno:95 fallocate'));
  assert.ok(!rules.includes('allow fallocate'));
  assert.ok(rules.includes('errno:38 clone3'));
  assert.ok(rules.includes('allow clone 0,MASKED_EQ,2114060288,0'));
  assert.ok(rules.includes('allow socket 0,NE,40,0'));
  assert.ok(rules.includes('allow arch_prctl'));
  assert.ok(rules.includes('allow ptrace'));
  for (const gated of ['mount', 'unshare', 'setns', 'chroot', 'bpf', 'reboot', 'init_module', 'open_by_handle_at']) {
    assert.ok(!rules.some((r) => r.split(' ')[1] === gated), `${gated} needs a capability sessions lack`);
  }
  assert.ok(!rules.includes('allow cacheflush'), 'arm-only rule dropped on amd64');
});

test('a spec field the cell cannot enforce fails the lease', () => {
  const privileged = buildContainerSpec('socket-1');
  privileged.HostConfig.Privileged = true;
  assert.throws(() => cellPolicy(privileged, HOST), /cannot enforce HostConfig.Privileged/);

  const bridged = buildContainerSpec('socket-1');
  bridged.HostConfig.NetworkMode = 'bridge';
  assert.throws(() => cellPolicy(bridged, HOST), /cannot enforce NetworkMode bridge/);

  const capped = buildContainerSpec('socket-1');
  capped.HostConfig.CapDrop = ['NET_RAW'];
  assert.throws(() => cellPolicy(capped, HOST), /CapDrop other than ALL/);
});

function fakeCell(socketPath) {
  const seen = { spawns: [], inputs: [], resizes: [], closed: 0, sockets: [] };
  const server = net.createServer((socket) => {
    seen.sockets.push(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const type = String.fromCharCode(buf[0]);
        const body = buf.subarray(5, 5 + buf.readUInt32BE(1));
        buf = buf.subarray(5 + body.length);
        if (type === 'S') {
          seen.spawns.push(body.toString().split('\0').filter(Boolean));
          socket.write(Buffer.concat([frame('K', 's1'), frame('O', 'tim.waldin.net ~ ')]));
        } else if (type === 'I') {
          seen.inputs.push(body.toString());
          socket.write(frame('O', `echo:${body}`));
        } else if (type === 'R') {
          seen.resizes.push(body.toString());
        } else if (type === 'U') {
          socket.write(frame('U', '4096 0'));
        }
      }
    });
    socket.on('close', () => { seen.closed++; });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, seen })));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a lease over a cell relays output, input, resize, usage and teardown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-'));
  const { server, seen } = await fakeCell(path.join(dir, 'cell-a.sock'));
  try {
    const lifecycle = new SessionLifecycle({ docker: new CellAdapter({ socketDir: dir }), poolSize: 0 });
    let output = '';
    let closed = 0;
    const handle = await lifecycle.lease('socket-1', {
      onOutput: (text) => { output += text; },
      onClose: () => { closed++; },
    });

    await waitFor(() => output === 'tim.waldin.net ~ ', 'output sent with the ready frame reaches the lease');
    assert.equal(seen.spawns[0][0], 'hostname=twaldin');
    assert.deepEqual(seen.resizes, ['140 40']);

    lifecycle.write(handle.handleId, 'ls\r');
    await waitFor(() => output.endsWith('echo:ls\r'), 'input echoed back');
    await lifecycle.resize(handle.handleId, 160, 45);
    await waitFor(() => seen.resizes.length === 2, 'resize frame');
    assert.equal(seen.resizes[1], '160 45');
    assert.equal(await lifecycle.writableBytes(handle.handleId), 4096);

    assert.equal(await lifecycle.destroy(handle.handleId), true);
    await waitFor(() => seen.closed === 1, 'destroy closes the cell connection');
    assert.equal(closed, 0, 'an explicit destroy unbinds the lease before closing');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell exiting closes the lease stream', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-'));
  const { server, seen } = await fakeCell(path.join(dir, 'cell-a.sock'));
  try {
    const lifecycle = new SessionLifecycle({ docker: new CellAdapter({ socketDir: dir }), poolSize: 0 });
    let closed = 0;
    const handle = await lifecycle.lease('socket-1', { onOutput() {}, onClose: () => { closed++; } });
    seen.sockets[0].end(frame('X', '0 0'));
    await waitFor(() => closed === 1, 'stream close reaches the lease');
    await assert.rejects(lifecycle.docker.writableBytes(handle.handleId), (error) => error.statusCode === 404);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a frame longer than any cellsh sends closes the lease', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-'));
  const { server, seen } = await fakeCell(path.join(dir, 'cell-a.sock'));
  try {
    const lifecycle = new SessionLifecycle({ docker: new CellAdapter({ socketDir: dir }), poolSize: 0 });
    let closed = 0;
    await lifecycle.lease('socket-1', { onOutput() {}, onClose: () => { closed++; } });
    seen.sockets[0].write(Buffer.from([0x4f, 0xff, 0xff, 0xff, 0xff]));
    await waitFor(() => closed === 1, 'an oversized frame ends the session');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no reachable cell fails the lease', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-'));
  try {
    const lifecycle = new SessionLifecycle({ docker: new CellAdapter({ socketDir: dir }), poolSize: 0 });
    await assert.rejects(lifecycle.lease('socket-1', { onOutput() {}, onClose() {} }), /no cell sockets/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
