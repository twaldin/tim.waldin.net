'use strict';
// Minimal regression tests for logger rotation — no test framework required.
// Run: node backend/test-logger-rotation.js
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

// Isolate via env: the logger module caches LOG_FILE / LOG_MAX_BYTES at
// require time, so set both BEFORE require('./logger').
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-rotation-test-'));
const LOG_FILE = path.join(tmpDir, 'events.jsonl');
const MAX_BYTES = 1024;
process.env.LOG_FILE = LOG_FILE;
process.env.LOG_MAX_BYTES = String(MAX_BYTES);

const { append, readAll } = require('./logger');

// ── rotation tests ────────────────────────────────────────────────────────────
// Two-file rotation only guarantees no event loss across a SINGLE rotation
// (a second rotation overwrites the .1 backup by design), so append until the
// first rotation happens, then a few more — and stop well before a second one.
let TOTAL = 0;
while (!fs.existsSync(LOG_FILE + '.1') && TOTAL < 100) {
  append({ type: 'command', seq: TOTAL, pad: 'x'.repeat(100) });
  TOTAL++;
}
for (let i = 0; i < 3; i++) {
  append({ type: 'command', seq: TOTAL, pad: 'x'.repeat(100) });
  TOTAL++;
}

ok('rotation: events.jsonl.1 exists after exceeding LOG_MAX_BYTES', () =>
  assert.ok(fs.existsSync(LOG_FILE + '.1'), 'expected rotated backup file'));

ok('rotation: current events.jsonl is smaller than LOG_MAX_BYTES', () =>
  assert.ok(fs.statSync(LOG_FILE).size < MAX_BYTES,
    `current file is ${fs.statSync(LOG_FILE).size} bytes, expected < ${MAX_BYTES}`));

// ── readAll continuity tests ──────────────────────────────────────────────────
const events = readAll();

ok('readAll: returns events from both files (no events lost to rotation)', () =>
  assert.strictEqual(events.length, TOTAL,
    `expected ${TOTAL} events, got ${events.length}`));

ok('readAll: events are in append order (earliest first, latest last)', () => {
  assert.strictEqual(events[0].seq, 0, 'first event should be seq 0');
  assert.strictEqual(events[events.length - 1].seq, TOTAL - 1,
    `last event should be seq ${TOTAL - 1}`);
  for (let i = 0; i < events.length; i++) {
    assert.strictEqual(events[i].seq, i, `event at index ${i} should be seq ${i}`);
  }
});

ok('readAll: every event is an object with the appended fields plus "at"', () => {
  for (const e of events) {
    assert.strictEqual(typeof e, 'object');
    assert.strictEqual(e.type, 'command');
    assert.strictEqual(typeof e.at, 'number');
  }
});

// ── cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} tests passed.`);
