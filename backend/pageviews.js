const logger = require('./logger');

// First-party pageview counting. The frontend fires navigator.sendBeacon('/pv')
// once per page load; this module validates, rate-limits, and aggregates
// in-memory {path → count} plus a daily rollup persisted through the existing
// JSONL audit logger. No database, no cookies, no per-user state — just counts.

const PATH_RE = /^[A-Za-z0-9/_.%-]*$/;
const MAX_PATH_LENGTH = 200;

// Cap distinct tracked paths so a garbage-path flood can't grow the maps
// unbounded; paths beyond the cap are lumped into one overflow bucket.
const MAX_PATHS = Number(process.env.PV_MAX_PATHS || 1000);
const OVERFLOW_PATH = '(other)';

// Per-IP rate limiting — same sliding-window pattern as connectionTracker in
// server.js. More than 30 beacons/min from one IP is a bot, not a reader.
const pvTracker = new Map(); // ip → [timestamps]
const MAX_PV_PER_IP = 30;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// Aggregates: all-time-since-boot plus a current-UTC-day map that is flushed
// to the audit log as a `pageview_rollup` event when the date rolls over.
const totals = new Map(); // path → count since boot
let todayDate = utcDay(Date.now());
let todayCounts = new Map(); // path → count for todayDate

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function checkRateLimit(ip) {
  const now = Date.now();
  if (!pvTracker.has(ip)) {
    pvTracker.set(ip, []);
  }
  const timestamps = pvTracker.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  // Drop the key entirely when nothing is left in the window so the map can't
  // accumulate a permanent empty-array entry per unique visitor IP.
  if (timestamps.length === 0) {
    pvTracker.delete(ip);
  } else {
    pvTracker.set(ip, timestamps);
  }

  if (timestamps.length >= MAX_PV_PER_IP) {
    pvTracker.set(ip, timestamps); // keep the full window for lockout
    return false;
  }
  timestamps.push(now);
  pvTracker.set(ip, timestamps);
  return true;
}

// Flush the current day's counts to the audit log. Multiple rollup events for
// the same date are additive (a restart mid-day writes a partial rollup and
// the fresh process writes another) — a consumer sums per-date.
function flushRollup() {
  if (todayCounts.size === 0) return;
  logger.append({
    type: 'pageview_rollup',
    date: todayDate,
    counts: Object.fromEntries(todayCounts),
  });
}

function rollOverIfNeeded(now) {
  const day = utcDay(now);
  if (day === todayDate) return;
  flushRollup();
  todayDate = day;
  todayCounts = new Map();
}

function bucketFor(path) {
  if (totals.has(path) || totals.size < MAX_PATHS) return path;
  return OVERFLOW_PATH;
}

// Express handler for POST /pv. sendBeacon posts text/plain, so the route
// mounts express.text() and the JSON.parse happens here.
function handlePageview(req, res) {
  const ip = req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';
  // Rate limit first so invalid-body floods consume the budget too.
  if (!checkRateLimit(ip)) {
    return res.status(429).end();
  }

  let parsed;
  try {
    parsed = JSON.parse(typeof req.body === 'string' ? req.body : '');
  } catch {
    return res.status(400).end();
  }
  const path = parsed && typeof parsed.path === 'string' ? parsed.path : '';
  if (!path || path.length > MAX_PATH_LENGTH || !PATH_RE.test(path)) {
    return res.status(400).end();
  }

  rollOverIfNeeded(Date.now());
  const bucket = bucketFor(path);
  totals.set(bucket, (totals.get(bucket) || 0) + 1);
  todayCounts.set(bucket, (todayCounts.get(bucket) || 0) + 1);
  res.status(204).end();
}

// Snapshot for the admin panel: per-path counts for today (UTC) and all-time
// since boot, sorted by all-time count descending.
function getPageviewStats() {
  rollOverIfNeeded(Date.now());
  const paths = [...totals.entries()]
    .map(([path, allTime]) => ({ path, allTime, today: todayCounts.get(path) || 0 }))
    .sort((a, b) => b.allTime - a.allTime);
  return { date: todayDate, paths };
}

// Drop stale per-IP entries so the tracker can't grow unbounded (mirrors the
// connectionTracker sweep in server.js). unref() so requiring this module
// (e.g. from tests) never holds the process open.
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of pvTracker) {
    if (!ts.length || now - ts[ts.length - 1] > RATE_LIMIT_WINDOW) {
      pvTracker.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = { handlePageview, getPageviewStats, flushRollup };
