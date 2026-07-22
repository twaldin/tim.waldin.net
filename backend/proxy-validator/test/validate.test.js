'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { buildContainerSpec, SANDBOX_POLICY } = require('../../sandbox-policy');
const { createProxyServer } = require('../index');
const { assertSandboxCompliant } = require('../validate');

function compliantSpec() {
  return buildContainerSpec('x');
}

function expectRejected(mutator) {
  const spec = compliantSpec();
  mutator(spec);
  assert.throws(() => assertSandboxCompliant(spec));
}

test('the policy-built container spec passes', () => {
  assert.doesNotThrow(() => assertSandboxCompliant(compliantSpec()));
});

test('rejects a privileged container', () => {
  expectRejected((spec) => { spec.HostConfig.Privileged = true; });
});

for (const [field, value] of [
  ['Binds', ['/host:/container']],
  ['Mounts', [{ Type: 'bind', Source: '/', Target: '/host' }]],
  ['Devices', [{ PathOnHost: '/dev/kvm', PathInContainer: '/dev/kvm' }]],
]) {
  test(`rejects non-empty HostConfig.${field}`, () => {
    expectRejected((spec) => { spec.HostConfig[field] = value; });
  });
}

test('rejects host network mode', () => {
  expectRejected((spec) => { spec.HostConfig.NetworkMode = 'host'; });
});

for (const [field, value] of [
  ['UsernsMode', 'host'],
  ['PidMode', 'host'],
  ['IpcMode', 'host'],
  ['UTSMode', 'host'],
  ['CgroupParent', '/docker/escape'],
]) {
  test(`rejects set host-namespace field HostConfig.${field}`, () => {
    expectRejected((spec) => { spec.HostConfig[field] = value; });
  });
}

test('rejects a SYS_ADMIN capability sneak', () => {
  expectRejected((spec) => { spec.HostConfig.CapAdd = ['SETUID', 'SYS_ADMIN']; });
});

test('rejects CapDrop that does not include ALL', () => {
  expectRejected((spec) => { spec.HostConfig.CapDrop = ['NET_RAW']; });
});

for (const securityOpt of [
  'apparmor=unconfined',
  'seccomp=unconfined',
  'no-new-privileges=false',
]) {
  test(`rejects unsafe SecurityOpt ${securityOpt}`, () => {
    expectRejected((spec) => { spec.HostConfig.SecurityOpt = [securityOpt]; });
  });
}

test('rejects an image swap', () => {
  expectRejected((spec) => { spec.Image = 'evil:latest'; });
});

for (const field of ['Memory', 'PidsLimit', 'CpuQuota']) {
  test(`rejects missing resource limit HostConfig.${field}`, () => {
    expectRejected((spec) => { delete spec.HostConfig[field]; });
  });

  test(`rejects inflated resource limit HostConfig.${field}`, () => {
    expectRejected((spec) => {
      spec.HostConfig[field] = SANDBOX_POLICY.hostConfig[field] + 1;
    });
  });

  test(`rejects unlimited zero resource limit HostConfig.${field}`, () => {
    expectRejected((spec) => { spec.HostConfig[field] = 0; });
  });
}

test('accepts stricter positive resource limits', () => {
  const spec = compliantSpec();
  spec.HostConfig.Memory -= 1;
  spec.HostConfig.PidsLimit -= 1;
  spec.HostConfig.CpuQuota -= 1;
  assert.doesNotThrow(() => assertSandboxCompliant(spec));
});

let upstream;
let proxy;
let upstreamPort;
let proxyPort;
let forwarded;

before(async () => {
  forwarded = [];
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      forwarded.push({ method: req.method, url: req.url, body });
      res.writeHead(201, { 'content-type': 'application/octet-stream' });
      res.end(body.length ? body : Buffer.from('upstream'));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = upstream.address().port;

  proxy = createProxyServer({ upstreamHost: '127.0.0.1', upstreamPort });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = proxy.address().port;
});

after(async () => {
  await Promise.all([
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
});

function request({ method = 'GET', path = '/', body }) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(body);
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method,
      path,
      headers: bytes ? { 'content-length': bytes.length, 'content-type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

test('forwards a compliant create request verbatim', async () => {
  const rawBody = `${JSON.stringify(compliantSpec(), null, 2)}\n`;
  const beforeCount = forwarded.length;
  const response = await request({ method: 'POST', path: '/v1.47/containers/create?name=session', body: rawBody });

  assert.equal(response.statusCode, 201);
  assert.equal(forwarded.length, beforeCount + 1);
  assert.equal(forwarded.at(-1).url, '/v1.47/containers/create?name=session');
  assert.deepEqual(forwarded.at(-1).body, Buffer.from(rawBody));
});

test('rejects a runtime image pull without contacting upstream', async () => {
  const beforeCount = forwarded.length;
  const response = await request({ method: 'POST', path: '/v1.47/images/create?fromImage=evil:latest' });

  assert.equal(response.statusCode, 403);
  assert.equal(forwarded.length, beforeCount);
});

test('rejects a runtime build without contacting upstream', async () => {
  const beforeCount = forwarded.length;
  const response = await request({ method: 'POST', path: '/build?t=evil:latest', body: 'archive' });

  assert.equal(response.statusCode, 403);
  assert.equal(forwarded.length, beforeCount);
});

test('rejects a noncompliant create without contacting upstream', async () => {
  const beforeCount = forwarded.length;
  const spec = compliantSpec();
  spec.HostConfig.Privileged = true;
  const response = await request({ method: 'POST', path: '/containers/create', body: JSON.stringify(spec) });

  assert.equal(response.statusCode, 403);
  assert.equal(forwarded.length, beforeCount);
});

test('forwards read and every allowed lifecycle action for a real container id', async () => {
  const id = 'a'.repeat(64);
  const beforeCount = forwarded.length;
  const paths = [
    { method: 'GET', path: `/containers/${id}/json` },
    ...['start', 'stop', 'kill', 'remove', 'attach', 'resize'].map((action) => ({
      method: 'POST',
      path: `/containers/${id}/${action}?option=1`,
    })),
    // Docker Engine's actual remove endpoint is DELETE /containers/{id}.
    { method: 'DELETE', path: `/containers/${id}?force=1` },
  ];

  for (const entry of paths) {
    const response = await request(entry);
    assert.equal(response.statusCode, 201, `${entry.method} ${entry.path}`);
  }

  assert.equal(forwarded.length, beforeCount + paths.length);
  assert.equal(forwarded.at(-1).url, `/containers/${id}?force=1`);
});

test('rejects lifecycle mutations without a real container id', async () => {
  const beforeCount = forwarded.length;
  const response = await request({ method: 'POST', path: '/containers/not-an-id/start' });

  assert.equal(response.statusCode, 403);
  assert.equal(forwarded.length, beforeCount);
});

test('rejects unlisted Docker mutations', async () => {
  const beforeCount = forwarded.length;
  const response = await request({ method: 'POST', path: '/containers/prune' });

  assert.equal(response.statusCode, 403);
  assert.equal(forwarded.length, beforeCount);
});
