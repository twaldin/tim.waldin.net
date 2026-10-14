'use strict';

// Per-kind connection policy through SessionManager (TWA-114): the handshake's
// auth.kind selects the idle / no-input windows and whether a command is
// auto-typed, and every refusal reaches the client as one `session_denied`.

const assert = require('node:assert/strict');
const test = require('node:test');
const SessionManager = require('../session');
const { Admission } = require('../admission');
const SessionLifecycle = require('../lifecycle');
const LifecycleFake = require('./lifecycle-fake');
const { makeFakeClock } = require('./fake-clock');
const { kindsWithWindows } = require('./kinds-with-windows');
const { SESSION_KINDS, parseSessionKind } = require('../session-kinds');

// Scaled-down windows; embed's idle window sits past its visible no-input
// window so each timer is told apart.
const SCALED_KINDS = {
  site: { ...SESSION_KINDS.site, idleMs: 3_000, noInputVisibleMs: 3_000, noInputHiddenMs: 600 },
  embed: { ...SESSION_KINDS.embed, idleMs: 1_500, noInputVisibleMs: 900, noInputHiddenMs: 200 },
};

function socket(id, ip, auth) {
  const emitted = [];
  return {
    id,
    handshake: { headers: { 'x-real-ip': ip }, auth },
    emit(event, payload) { emitted.push({ event, payload }); },
    disconnect() { this.disconnected = true; },
    emitted,
    disconnected: false,
  };
}

const siteSocket = () => socket('site', '203.0.113.1', { sessionId: 'browser-a' });
const embedSocket = () => socket('embed', '203.0.113.1', { kind: 'embed', sessionId: 'iframe-1' });

/**
 * SessionManager on mocked timers over an admission that replays a warmed
 * prompt and hands each kind its own cold lease (`H-site`, `H-embed`).
 */
function managerOnMockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const admission = {
    checkConnectionRate: () => true,
    tryAcquire: async (_ip, { kind, onOutput }) => {
      onOutput('~ ');
      return { mode: 'cold', lease: { leaseId: `L-${kind}`, handleId: `H-${kind}` } };
    },
    zombify: () => true,
    destroy: async () => true,
  };
  const lifecycle = {
    write: (handleId, data) => { writes.push([handleId, data]); },
    resize: async () => {},
  };
  return { mgr: new SessionManager({ lifecycle, admission, kinds: SCALED_KINDS }), writes };
}

/** The real SessionManager → Admission → SessionLifecycle over LifecycleFake. */
function composition(t, maxSessions) {
  const lifecycle = new SessionLifecycle({ docker: new LifecycleFake(), poolSize: 0 });
  const admission = new Admission({ lifecycle, maxSessions, clock: makeFakeClock() });
  const mgr = new SessionManager({ lifecycle, admission, kinds: kindsWithWindows() });
  t.after(() => { for (const state of mgr.conns.values()) mgr._clearTimers(state); });
  return mgr;
}

const deniedWith = (reason) => [{ event: 'session_denied', payload: { reason } }];

test('parseSessionKind selects embed only for the exact string embed', () => {
  assert.deepEqual(
    ['embed', 'site', undefined, 'EMBED', 42].map((raw) => parseSessionKind(raw)),
    ['embed', 'site', 'site', 'site', 'site'],
  );
});

test('an embed that never types ends at its hidden no-input window; a site connection from the same IP stays', async (t) => {
  const { mgr } = managerOnMockTimers(t);
  const site = siteSocket();
  const embed = embedSocket();
  await mgr.handleConnect(site);
  await mgr.handleConnect(embed);

  t.mock.timers.tick(199);
  const before = [site.disconnected, embed.disconnected];
  t.mock.timers.tick(1);

  assert.deepEqual(before, [false, false]);
  assert.deepEqual([site.disconnected, embed.disconnected], [false, true]);
  assert.deepEqual([...mgr.conns.keys()], ['site']);
});

test('a visible embed keeps its longer no-input window', async (t) => {
  const { mgr } = managerOnMockTimers(t);
  const embed = embedSocket();
  await mgr.handleConnect(embed);
  mgr.handleVisibility(embed.id, false);

  t.mock.timers.tick(899);
  const before = embed.disconnected;
  t.mock.timers.tick(1);

  assert.equal(before, false);
  assert.equal(embed.disconnected, true);
});

test('an embed that typed ends at its idle window after the last keystroke; a site connection still has time', async (t) => {
  const { mgr } = managerOnMockTimers(t);
  const site = siteSocket();
  const embed = embedSocket();
  await mgr.handleConnect(site);
  await mgr.handleConnect(embed);
  mgr.handleInput(site.id, 'l');
  mgr.handleInput(embed.id, 'l');
  t.mock.timers.tick(1_000);
  mgr.handleInput(embed.id, 's');

  t.mock.timers.tick(1_499);
  const before = embed.disconnected;
  t.mock.timers.tick(1);

  assert.equal(before, false);
  assert.deepEqual([site.disconnected, embed.disconnected], [false, true]);
  assert.deepEqual(embed.emitted.at(-1), { event: 'output', payload: '\r\n[session idle — closed]\r\n' });
});

test('an embed never auto-types a command; a site connection still types boot', async (t) => {
  const { mgr, writes } = managerOnMockTimers(t);
  const site = siteSocket();
  const embed = embedSocket();
  await mgr.handleConnect(site);
  await mgr.handleConnect(embed);

  mgr.handleResize(site.id, 100, 30);
  mgr.handleResize(embed.id, 100, 30);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20);

  assert.deepEqual(writes, [['H-site', 'boot\r']]);
});

test('a full server denies with session_denied capacity and hangs up', async (t) => {
  const mgr = composition(t, 1);
  await mgr.handleConnect(socket('holder', '203.0.113.1', { sessionId: 'browser-a' }));
  const late = socket('late', '203.0.113.2', { kind: 'embed', sessionId: 'iframe-1' });

  await mgr.handleConnect(late);

  assert.deepEqual(late.emitted, deniedWith('capacity'));
  assert.equal(late.disconnected, true);
  assert.deepEqual([...mgr.conns.keys()], ['holder']);
});

test('a fifth embed from one IP is denied with session_denied ip-cap and the four keep their shells', async (t) => {
  const mgr = composition(t, 40);
  for (let iframe = 1; iframe <= 4; iframe += 1) {
    await mgr.handleConnect(socket(`iframe-${iframe}`, '203.0.113.1', { kind: 'embed', sessionId: `iframe-${iframe}` }));
  }
  const fifth = socket('iframe-5', '203.0.113.1', { kind: 'embed', sessionId: 'iframe-5' });

  await mgr.handleConnect(fifth);

  assert.deepEqual(fifth.emitted, deniedWith('ip-cap'));
  assert.equal(fifth.disconnected, true);
  assert.deepEqual([...mgr.conns.keys()], ['iframe-1', 'iframe-2', 'iframe-3', 'iframe-4']);
});

test('a session id from another IP and a failing admission are denied with session_denied unavailable', async (t) => {
  const mgr = composition(t, 40);
  await mgr.handleConnect(socket('owner', '203.0.113.1', { sessionId: 'browser-a' }));
  const elsewhere = socket('elsewhere', '203.0.113.2', { sessionId: 'browser-a' });
  const broken = new SessionManager({
    lifecycle: {},
    admission: {
      checkConnectionRate: () => true,
      tryAcquire: async () => { throw new Error('docker unreachable'); },
    },
  });
  const unlucky = socket('unlucky', '203.0.113.3', { sessionId: 'browser-c' });

  await mgr.handleConnect(elsewhere);
  await broken.handleConnect(unlucky);

  assert.deepEqual(elsewhere.emitted, deniedWith('unavailable'));
  assert.deepEqual(unlucky.emitted, deniedWith('unavailable'));
  assert.deepEqual([elsewhere.disconnected, unlucky.disconnected], [true, true]);
});
