'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, writeFile, rename, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const CgroupWrites = require('../cgroup-writes');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cgroup-writes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const group = path.join(root, 'docker', 'container-id');
  await mkdir(group, { recursive: true });
  return { guard: new CgroupWrites(root), stats: path.join(group, 'io.stat') };
}

test('all device write counters contribute, and crossing the threshold keeps inspections enabled', async (t) => {
  const { guard, stats } = await fixture(t);
  await writeFile(stats, '8:0 wbytes=134217727 rbytes=0\n8:1 rbytes=0 wbytes=134217728\n');
  assert.equal(await guard.requiresInspection('container-id'), false);
  await writeFile(stats, '8:0 wbytes=134217728 rbytes=0\n8:1 rbytes=0 wbytes=134217728\n');
  assert.equal(await guard.requiresInspection('container-id'), true);
  await writeFile(stats, '8:0 wbytes=0 rbytes=0\n');
  assert.equal(await guard.requiresInspection('container-id'), true);
});

test('missing, empty, and malformed counters require a full inspection', async (t) => {
  const { guard, stats } = await fixture(t);
  assert.equal(await guard.requiresInspection('container-id'), true);
  await writeFile(stats, '');
  assert.equal(await guard.requiresInspection('container-id'), true);
  await writeFile(stats, '8:0 rbytes=0 wbytes=-1\n');
  assert.equal(await guard.requiresInspection('container-id'), true);
  await writeFile(stats, '8:0 rbytes=0 wbytes=4096\n');
  assert.equal(await guard.requiresInspection('container-id'), false);
});

test('a reset counter switches permanently to size inspections until the handle is forgotten', async (t) => {
  const { guard, stats } = await fixture(t);
  await writeFile(stats, '8:0 wbytes=8192\n');
  assert.equal(await guard.requiresInspection('container-id'), false);
  await writeFile(stats, '8:0 wbytes=4096\n');
  assert.equal(await guard.requiresInspection('container-id'), true);
  guard.forget('container-id');
  assert.equal(await guard.requiresInspection('container-id'), false);
});

test('a replacement cgroup cannot reuse the prior low-write authorization', async (t) => {
  const { guard, stats } = await fixture(t);
  await writeFile(stats, '8:0 wbytes=0\n');
  assert.equal(await guard.requiresInspection('container-id'), false);
  const replacement = `${stats}.replacement`;
  await writeFile(replacement, '8:0 wbytes=0\n');
  await rename(replacement, stats);
  assert.equal(await guard.requiresInspection('container-id'), true);
});

test('forgetting a handle during a read cannot retain its old authorization', async (t) => {
  const { guard, stats } = await fixture(t);
  await writeFile(stats, '8:0 wbytes=4096\n');
  const pending = guard.requiresInspection('container-id');
  guard.forget('container-id');
  assert.equal(await pending, true);
  assert.equal(await guard.requiresInspection('container-id'), false);
});
