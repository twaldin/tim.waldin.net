'use strict';
// Minimal regression tests for the /pv pageview endpoint — no test framework required.
// Run: node backend/test/pageviews.test.js (or `npm test` in backend/)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Isolate via env BEFORE require: the logger caches LOG_FILE and pageviews
// caches PV_MAX_PATHS at require time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pageviews-test-'));
process.env.LOG_FILE = path.join(tmpDir, 'events.jsonl');
process.env.PV_MAX_PATHS = '5';

const { handlePageview, getPageviewStats, flushRollup } = require('../pageviews');
const { readAll } = require('../logger');

// Fake req/res in the same style as admin-auth.test.js. Distinct test IPs so
// rate-limit state doesn't bleed between tests.
function makeReq(body, ip) {
  return { headers: { 'x-real-ip': ip }, body };
}

function makeRes() {
  const res = {
    _statusCode: null,
    _ended: false,
    status(code) { res._statusCode = code; return res; },
    end() { res._ended = true; return res; },
  };
  return res;
}

function beacon(pvPath, ip) {
  const res = makeRes();
  handlePageview(makeReq(JSON.stringify({ path: pvPath }), ip), res);
  return res;
}

function countFor(pvPath) {
  const entry = getPageviewStats().paths.find(p => p.path === pvPath);
  return entry ? entry.allTime : 0;
}

// ── validation ────────────────────────────────────────────────────────────────
ok('valid path → 204 and counted', () => {
  const res = beacon('/blog/some-post', '203.0.113.1');
  assert.strictEqual(res._statusCode, 204);
  assert.strictEqual(countFor('/blog/some-post'), 1);
});

ok('repeat views increment the count', () => {
  beacon('/blog/some-post', '203.0.113.1');
  assert.strictEqual(countFor('/blog/some-post'), 2);
});

ok('encoded path chars (%20, dots, dashes) are accepted', () => {
  const res = beacon('/projects/term-site%20v2.0_beta', '203.0.113.1');
  assert.strictEqual(res._statusCode, 204);
});

ok('non-JSON body → 400', () => {
  const res = makeRes();
  handlePageview(makeReq('not json', '203.0.113.2'), res);
  assert.strictEqual(res._statusCode, 400);
});

ok('missing body → 400', () => {
  const res = makeRes();
  handlePageview(makeReq(undefined, '203.0.113.2'), res);
  assert.strictEqual(res._statusCode, 400);
});

ok('missing path field → 400', () => {
  const res = makeRes();
  handlePageview(makeReq(JSON.stringify({ page: '/x' }), '203.0.113.2'), res);
  assert.strictEqual(res._statusCode, 400);
});

ok('non-string path → 400', () => {
  const res = makeRes();
  handlePageview(makeReq(JSON.stringify({ path: 42 }), '203.0.113.2'), res);
  assert.strictEqual(res._statusCode, 400);
});

ok('empty path → 400', () => {
  const res = beacon('', '203.0.113.2');
  assert.strictEqual(res._statusCode, 400);
});

ok('path over 200 chars → 400', () => {
  const res = beacon('/' + 'a'.repeat(200), '203.0.113.2');
  assert.strictEqual(res._statusCode, 400);
});

ok('path with shell metachars → 400', () => {
  for (const bad of ['/x?q=1', '/x y', '/x<script>', '/x;rm', '/x&y', "/x'y"]) {
    const res = beacon(bad, '203.0.113.2');
    assert.strictEqual(res._statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

ok('invalid paths are not counted', () => {
  assert.strictEqual(countFor('/x?q=1'), 0);
  assert.strictEqual(countFor(''), 0);
});

// ── rate limiting ─────────────────────────────────────────────────────────────
ok('31st beacon in a minute from one IP → 429', () => {
  const ip = '203.0.113.30';
  for (let i = 0; i < 30; i++) {
    const res = beacon('/rate-limit-test', ip);
    assert.strictEqual(res._statusCode, 204, `beacon ${i + 1} should be 204`);
  }
  const res = beacon('/rate-limit-test', ip);
  assert.strictEqual(res._statusCode, 429);
  assert.strictEqual(countFor('/rate-limit-test'), 30, 'rejected beacon must not be counted');
});

ok('rate limit is per-IP: another IP is unaffected', () => {
  const res = beacon('/rate-limit-test', '203.0.113.31');
  assert.strictEqual(res._statusCode, 204);
});

// ── stats shape ───────────────────────────────────────────────────────────────
ok('getPageviewStats: sorted by all-time desc, today ≤ allTime', () => {
  const stats = getPageviewStats();
  assert.strictEqual(stats.date, new Date().toISOString().slice(0, 10));
  for (let i = 1; i < stats.paths.length; i++) {
    assert.ok(stats.paths[i - 1].allTime >= stats.paths[i].allTime, 'not sorted');
  }
  for (const p of stats.paths) {
    assert.ok(p.today <= p.allTime, `today > allTime for ${p.path}`);
  }
});

// ── path-cap overflow ─────────────────────────────────────────────────────────
ok('beyond PV_MAX_PATHS distinct paths, new paths bucket into (other)', () => {
  // PV_MAX_PATHS=5; earlier tests already tracked 3 distinct paths. Fill the
  // cap, then overflow twice.
  beacon('/fill-1', '203.0.113.40');
  beacon('/fill-2', '203.0.113.40');
  beacon('/overflow-1', '203.0.113.40');
  beacon('/overflow-2', '203.0.113.40');
  assert.strictEqual(countFor('/overflow-1'), 0);
  assert.strictEqual(countFor('/overflow-2'), 0);
  assert.strictEqual(countFor('(other)'), 2);
});

ok('already-tracked paths still count past the cap', () => {
  beacon('/blog/some-post', '203.0.113.40');
  assert.strictEqual(countFor('/blog/some-post'), 3);
});

// ── daily rollup persistence ──────────────────────────────────────────────────
ok('flushRollup: writes a pageview_rollup event with today\'s counts', () => {
  flushRollup();
  const rollups = readAll().filter(e => e.type === 'pageview_rollup');
  assert.strictEqual(rollups.length, 1);
  const r = rollups[0];
  assert.strictEqual(r.date, new Date().toISOString().slice(0, 10));
  assert.strictEqual(r.counts['/blog/some-post'], 3);
  assert.strictEqual(r.counts['(other)'], 2);
  assert.strictEqual(typeof r.at, 'number');
});

// ── cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} tests passed.`);
