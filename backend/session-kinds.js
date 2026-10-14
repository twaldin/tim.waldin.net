'use strict';

const SESSION_KINDS = Object.freeze({
  site: Object.freeze({
    idleMs: 300_000,
    noInputVisibleMs: 300_000,
    noInputHiddenMs: 60_000,
    ip: Object.freeze({ mode: 'replace' }),
    runsInitCommand: true,
  }),
  embed: Object.freeze({
    idleMs: 90_000,
    noInputVisibleMs: 90_000,
    noInputHiddenMs: 20_000,
    ip: Object.freeze({ mode: 'share', maxPerIp: 4 }),
    runsInitCommand: false,
  }),
});

/** Handshake `auth.kind` → kind. Only the exact string 'embed' selects the embed. */
function parseSessionKind(raw) {
  return raw === 'embed' ? 'embed' : 'site';
}

module.exports = { SESSION_KINDS, parseSessionKind };
