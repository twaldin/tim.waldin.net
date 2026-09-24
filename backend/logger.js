const fs = require('fs');
const path = require('path');

const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'data', 'events.jsonl');
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024); // 5 MB

const MAX_INIT_COMMAND_LENGTH = 200;
const MAX_USER_AGENT_LENGTH = 512;
const MAX_REFERRER_LENGTH = 1024;
const MAX_COMMAND_LENGTH = 1024;
const MAX_REASON_LENGTH = 128;
const REDACTED = '[REDACTED]';

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

// Bounded copy of a visitor-supplied string with token-shaped secrets replaced.
function redactSecrets(value, maxLength) {
  // Scan a small amount past the output limit so a credential beginning near
  // the boundary is redacted before the final truncation.
  let sanitized = boundedString(value, maxLength + 512);
  sanitized = sanitized
    .replace(
      /\b(authorization\s*:\s*bearer\s+)(?:"[^"]*"|'[^']*'|[^\s,'";]+)/gi,
      `$1${REDACTED}`
    )
    .replace(
      // Also prefixed/suffixed names: GITHUB_TOKEN=, DB_PASSWORD=, AWS_SECRET_ACCESS_KEY=.
      /\b([A-Za-z0-9_]*(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      `$1=${REDACTED}`
    )
    .replace(
      // curl/wget-style user:password arguments: -u alice:pw, --user=alice:pw.
      /(^|\s)(-u\s*|--user[=\s]\s*)(?:(["'])([^\s:'"]*:)[^'"]*\3|([^\s:'"]+:)(?:"[^"]*"|'[^']*'|[^\s'"]+))/g,
      (match, lead, flag, quote, quotedUser, user) => (quote
        ? `${lead}${flag}${quote}${quotedUser}${REDACTED}${quote}`
        : `${lead}${flag}${user}${REDACTED}`)
    )
    .replace(
      // URL userinfo: https://alice:pw@host.
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
      `$1${REDACTED}@`
    )
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      REDACTED
    );
  return sanitized.slice(0, maxLength);
}

function sanitizeEvent(event) {
  if (event.type === 'session_start') {
    return {
      ...event,
      ip: boundedString(event.ip, 64),
      ua: boundedString(event.ua, MAX_USER_AGENT_LENGTH),
      referrer: redactSecrets(event.referrer, MAX_REFERRER_LENGTH),
      initCommand: redactSecrets(event.initCommand, MAX_INIT_COMMAND_LENGTH),
    };
  }
  if (event.type === 'command') {
    return { ...event, cmd: redactSecrets(event.cmd, MAX_COMMAND_LENGTH) };
  }
  if (event.type === 'session_end') {
    return { ...event, reason: boundedString(event.reason, MAX_REASON_LENGTH) };
  }
  return event;
}

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

// Appends every event with one write, so a multi-line paste that completes
// many commands in a single input event costs one file write, not hundreds.
function append(...events) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    rotateIfNeeded();
    const at = Date.now();
    fs.appendFileSync(LOG_FILE, events.map((event) => JSON.stringify({ ...sanitizeEvent(event), at }) + '\n').join(''));
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

module.exports = {
  append,
  readAll,
  _sanitizeEvent: sanitizeEvent,
};
