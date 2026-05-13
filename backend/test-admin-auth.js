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

console.log(`\n${passed} tests passed.`);
