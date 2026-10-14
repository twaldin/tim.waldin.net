'use strict';

const { SESSION_KINDS } = require('../session-kinds');

/**
 * A mutable copy of SESSION_KINDS, injectable as SessionManager's `kinds`, with
 * every kind's idle and no-input windows set to `ms` (default: never in a test).
 */
function kindsWithWindows(ms = 60_000_000) {
  return Object.fromEntries(Object.entries(SESSION_KINDS).map(([kind, policy]) => [
    kind,
    { ...policy, idleMs: ms, noInputVisibleMs: ms, noInputHiddenMs: ms },
  ]));
}

module.exports = { kindsWithWindows };
