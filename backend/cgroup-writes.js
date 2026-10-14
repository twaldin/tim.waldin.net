'use strict';

const { open } = require('node:fs/promises');
const path = require('node:path');

const INSPECT_AFTER_BYTES = 256n * 1024n * 1024n;

function writtenBytes(text) {
  const lines = text.trim().split('\n');
  let bytes = 0n;
  for (const line of lines) {
    const match = line.match(/^\d+:\d+\s+.*?\bwbytes=(\d+)(?:\s|$)/);
    if (!match) return null;
    bytes += BigInt(match[1]);
  }
  return bytes;
}

class CgroupWrites {
  constructor(root = '/host-cgroup') {
    this.root = root;
    this.records = new Map();
  }

  async requiresInspection(handleId) {
    let record = this.records.get(handleId);
    if (record?.inspect) return true;
    if (!record) {
      record = { path: null, identity: null, bytes: 0n, inspect: false };
      this.records.set(handleId, record);
    }
    const candidates = record.path ? [record.path] : [
      path.join(this.root, 'system.slice', `docker-${handleId}.scope`, 'io.stat'),
      path.join(this.root, 'docker', handleId, 'io.stat'),
    ];
    for (const candidate of candidates) {
      try {
        const file = await open(candidate, 'r');
        try {
          const stat = await file.stat({ bigint: true });
          const identity = `${stat.dev}:${stat.ino}`;
          const bytes = writtenBytes(await file.readFile('utf8'));
          if (this.records.get(handleId) !== record) return true;
          if (record.identity !== null && record.identity !== identity) record.inspect = true;
          record.path = candidate;
          record.identity = identity;
          if (bytes === null) return true;
          if (bytes < record.bytes || bytes >= INSPECT_AFTER_BYTES) record.inspect = true;
          record.bytes = bytes;
          return record.inspect;
        } finally {
          await file.close();
        }
      } catch (error) {
        if (record.identity !== null) record.inspect = true;
        if (error.code !== 'ENOENT') break;
      }
    }
    return true;
  }

  forget(handleId) {
    this.records.delete(handleId);
  }
}

module.exports = CgroupWrites;
