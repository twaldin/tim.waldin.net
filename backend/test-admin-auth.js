'use strict';
// Minimal regression tests for admin basicAuth — no test framework required.
// Run: node backend/test-admin-auth.js
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

// ── safeEqual unit tests ──────────────────────────────────────────────────────
const { _safeEqual: safeEqual } = require('./admin.js');

ok('safeEqual: identical strings match', () =>
  assert.strictEqual(safeEqual('abc', 'abc'), true));

ok('safeEqual: different strings do not match', () =>
  assert.strictEqual(safeEqual('abc', 'xyz'), false));

ok('safeEqual: different lengths do not throw', () =>
  assert.doesNotThrow(() => safeEqual('short', 'a-much-longer-string')));

ok('safeEqual: different lengths return false', () =>
  assert.strictEqual(safeEqual('short', 'a-much-longer-string'), false));

ok('safeEqual: empty vs non-empty does not throw', () =>
  assert.doesNotThrow(() => safeEqual('', 'password')));

ok('safeEqual: empty vs non-empty returns false', () =>
  assert.strictEqual(safeEqual('', 'password'), false));

ok('safeEqual: empty vs empty matches', () =>
  assert.strictEqual(safeEqual('', ''), true));

// ── basicAuth middleware integration tests ────────────────────────────────────
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.ADMIN_PASSWORD = 'correct-password';

// Re-require after env is set so the module picks up the env vars at call time
const { _basicAuth: basicAuth } = require('./admin.js');

function makeReq(authHeader) {
  return { headers: { authorization: authHeader || '' } };
}

function makeRes() {
  let statusCode = null;
  const headers = {};
  const res = {
    _statusCode: null,
    _body: null,
    status(code) { res._statusCode = code; return res; },
    send(body) { res._body = body; return res; },
    set(k, v) { headers[k] = v; return res; },
    headers,
  };
  return res;
}

function encode(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

ok('basicAuth: no auth header → 401', () => {
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReq(''), res, () => { nextCalled = true; });
  assert.strictEqual(res._statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

ok('basicAuth: wrong username (different length) → 401, not 500', () => {
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReq(encode('x', 'correct-password')), res, () => { nextCalled = true; });
  assert.strictEqual(res._statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

ok('basicAuth: wrong password (different length) → 401, not 500', () => {
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReq(encode('admin@example.com', 'wrong')), res, () => { nextCalled = true; });
  assert.strictEqual(res._statusCode, 401);
  assert.strictEqual(nextCalled, false);
});

ok('basicAuth: empty user and pass → 401, not 500', () => {
  const res = makeRes();
  basicAuth(makeReq(encode('', '')), res, () => {});
  assert.strictEqual(res._statusCode, 401);
});

ok('basicAuth: correct credentials → next() called', () => {
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReq(encode('admin@example.com', 'correct-password')), res, () => { nextCalled = true; });
  assert.strictEqual(res._statusCode, null, 'should not set status on success');
  assert.strictEqual(nextCalled, true);
});

ok('basicAuth: password with colon is handled correctly', () => {
  process.env.ADMIN_PASSWORD = 'pass:with:colons';
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReq(encode('admin@example.com', 'pass:with:colons')), res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  process.env.ADMIN_PASSWORD = 'correct-password';
});

ok('basicAuth: no ADMIN_PASSWORD → 503', () => {
  const saved = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  const res = makeRes();
  basicAuth(makeReq(encode('admin@example.com', 'x')), res, () => {});
  assert.strictEqual(res._statusCode, 503);
  process.env.ADMIN_PASSWORD = saved;
});

// ── per-IP brute-force throttle tests ─────────────────────────────────────────
// Build a req carrying an x-real-ip header so the throttle keys per-IP and
// distinct test IPs don't bleed lockout state into each other.
function makeReqFromIp(authHeader, ip) {
  return { headers: { authorization: authHeader || '', 'x-real-ip': ip } };
}

ok('basicAuth: 5 wrong passwords then 6th from same IP → 429 + Retry-After', () => {
  const ip = '203.0.113.10';
  const wrong = encode('admin@example.com', 'nope');
  for (let i = 0; i < 5; i++) {
    const res = makeRes();
    basicAuth(makeReqFromIp(wrong, ip), res, () => {});
    assert.strictEqual(res._statusCode, 401, `attempt ${i + 1} should be 401`);
  }
  const res = makeRes();
  let nextCalled = false;
  basicAuth(makeReqFromIp(wrong, ip), res, () => { nextCalled = true; });
  assert.strictEqual(res._statusCode, 429, '6th attempt should be 429');
  assert.ok(res.headers['Retry-After'], 'Retry-After header should be set');
  assert.strictEqual(nextCalled, false);
});

ok('basicAuth: correct credentials reset the failure counter', () => {
  const ip = '203.0.113.20';
  const wrong = encode('admin@example.com', 'nope');
  const right = encode('admin@example.com', 'correct-password');
  for (let i = 0; i < 4; i++) {
    basicAuth(makeReqFromIp(wrong, ip), makeRes(), () => {});
  }
  // Correct request clears the counter.
  let nextCalled = false;
  basicAuth(makeReqFromIp(right, ip), makeRes(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'correct creds should call next()');
  // 4 more wrong attempts: still under the limit because the counter reset.
  for (let i = 0; i < 4; i++) {
    const res = makeRes();
    basicAuth(makeReqFromIp(wrong, ip), res, () => {});
    assert.strictEqual(res._statusCode, 401, `post-reset attempt ${i + 1} should be 401, not 429`);
  }
});

ok('basicAuth: missing Authorization header → 401 and does not count toward lockout', () => {
  const ip = '203.0.113.30';
  // Many no-auth requests (as a browser sends on first load) must never lock out.
  for (let i = 0; i < 10; i++) {
    const res = makeRes();
    basicAuth(makeReqFromIp('', ip), res, () => {});
    assert.strictEqual(res._statusCode, 401, `no-auth request ${i + 1} should be 401`);
  }
  // A subsequent wrong-password attempt still gets 401 (counter starts at 1),
  // proving the no-auth requests were not counted.
  const res = makeRes();
  basicAuth(makeReqFromIp(encode('admin@example.com', 'nope'), ip), res, () => {});
  assert.strictEqual(res._statusCode, 401, 'first real failure should be 401, not 429');
});

console.log(`\n${passed} tests passed.`);
