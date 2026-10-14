'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SESSION = path.join(__dirname, '..', 'session.js');

function load(env) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SESSION)})`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
}

test('POOL_SIZE may be 0 and MAX_SESSIONS may be 1', () => {
  assert.equal(load({ POOL_SIZE: '0', MAX_SESSIONS: '1' }).status, 0);
});

for (const [name, raw, min] of [
  ['POOL_SIZE', 'Infinity', 0],
  ['POOL_SIZE', '1e309', 0],
  ['POOL_SIZE', '-1', 0],
  ['POOL_SIZE', '2.5', 0],
  ['POOL_SIZE', 'five', 0],
  ['POOL_SIZE', '', 0],
  ['MAX_SESSIONS', 'NaN', 1],
  ['MAX_SESSIONS', '0', 1],
]) {
  test(`${name}=${JSON.stringify(raw)} stops the backend at load`, () => {
    const result = load({ [name]: raw });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`RangeError: ${name} must be an integer >= ${min}`));
  });
}
