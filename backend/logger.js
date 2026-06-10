const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'data', 'events.jsonl');
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024); // 5 MB

function rotateIfNeeded() {
  try {
    const { size } = fs.statSync(LOG_FILE);
    if (size < MAX_BYTES) return;
    // Single-backup rotation: events.jsonl -> events.jsonl.1 (overwrite).
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Log rotate error:', err.message);
  }
}

function append(event) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ...event, at: Date.now() }) + '\n');
  } catch (err) {
    console.error('Logger error:', err.message);
  }
}

function readOne(file) {
  try {
    return fs.readFileSync(file, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readAll() {
  return [...readOne(LOG_FILE + '.1'), ...readOne(LOG_FILE)];
}

module.exports = { append, readAll };
