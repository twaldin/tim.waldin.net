'use strict';

const { SESSION_KINDS } = require('../session-kinds');

function kindsWithWindows(ms = 60_000_000) {
  return Object.fromEntries(Object.entries(SESSION_KINDS).map(([kind, policy]) => [
    kind,
    { ...policy, idleMs: ms, noInputVisibleMs: ms, noInputHiddenMs: ms },
  ]));
}

module.exports = { kindsWithWindows };
