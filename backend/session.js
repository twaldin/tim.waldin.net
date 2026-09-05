'use strict';

// SessionManager — the session orchestration controller (the third module).
//
// The old god-module held everything: dockerode, the pool, zombie/restore logic,
// idle timers, and initCommand auto-typing. It is now split along two seams:
//   - SessionLifecycle (./lifecycle)  owns ALL dockerode authority + the pool.
//   - Admission        (./admission)  owns who gets a slot (atomic lease, IP,
//                                     persistent restore, rate limit, zombies).
// This module owns what neither of those should: the per-connection behaviour —
// idle/no-input timers, initCommand auto-typing + validation, prompt sniffing,
// the resize gate, and wiring container output to a socket. It holds no
// dockerode and does no capacity bookkeeping. Those concerns are one seam away.

const SessionLifecycle = require('./lifecycle');
const { Admission } = require('./admission');

class SessionManager {
  constructor({ lifecycle, admission } = {}) {
    this.lifecycle = lifecycle || new SessionLifecycle({ poolSize: 5 });
    this.admission = admission || new Admission({ lifecycle: this.lifecycle, maxSessions: 40 });

    // Idle kill: no USER INPUT for this long.
    this.sessionTimeout = 5 * 60 * 1000;
    // Bot kill: a session that never receives input within this window is freed.
    this.noInputTimeout = 60 * 1000;
    // Visibility-aware relaxation: a visible page gets the longer window.
    this.noInputTimeoutVisible = 5 * 60 * 1000;

    // socket.id -> per-connection controller state
    this.conns = new Map();

    // Best-effort startup reclaim against a real lifecycle only: remove
    // portfolio containers orphaned by a previous backend run. Strictly
    // label-scoped (never other tenants). Tests inject a fake and skip this.
    if (!lifecycle) {
      this.lifecycle.reclaimOrphans().catch((e) => {
        console.error('startup reclaim failed:', e.message);
      });
    }
  }

  /** Wire a freshly-connected socket to a (new or restored) session. */
  async handleConnect(socket) {
    const clientIP = socket.handshake.headers['x-real-ip'] || socket.handshake.address;
    const initCommand = typeof socket.handshake.auth?.initCommand === 'string'
      ? socket.handshake.auth.initCommand : undefined;
    const persistentId = typeof socket.handshake.auth?.sessionId === 'string'
      ? socket.handshake.auth.sessionId : undefined;

    const state = {
      socket,
      ip: clientIP,
      lease: null,
      initCommand,
      promptSeen: false,
      firstResizeApplied: false,
      initCommandRun: false,
      hasReceivedInput: false,
      pageVisible: undefined,
      pendingResize: null,
      pendingHidden: undefined,
      timeout: null,
      noInputTimer: null,
      resizeFallback: null,
      superseded: false,
    };
    this.conns.set(socket.id, state);

    // Connection rate limit — all admission policy lives in Admission now.
    if (!this.admission.checkConnectionRate(clientIP)) {
      socket.emit('error', 'Too many connections. Please wait a minute.');
      socket.disconnect();
      this.conns.delete(socket.id);
      return;
    }

    // The output sink: forward container output to the socket AND sniff for the
    // zsh prompt to gate the initCommand. Alt-screen tracking is owned by the
    // lifecycle handle (rebind replays the alt-screen enter sequence).
    const onOutput = (output) => {
      try { socket.emit('output', output); } catch { /* socket gone */ }
      if (!state.promptSeen && output.includes('~ ')) {
        state.promptSeen = true;
        this._maybeRunInitCommand(socket.id);
      }
    };
    const onClose = () => this._handleStreamClose(socket.id);
    // A later connection presenting the same sessionId (a second tab in the
    // same browser) takes the stream; Admission calls this in the same tick.
    const onSuperseded = () => this._retire(socket.id);

    let result;
    try {
      result = await this.admission.tryAcquire(
        clientIP, { persistentId, initCommand, onOutput, onClose, onSuperseded });
    } catch (e) {
      console.error(`handleConnect failed for ${socket.id}:`, e.message);
      socket.emit('error', 'Failed to create terminal session');
      socket.disconnect();
      this.conns.delete(socket.id);
      return;
    }

    if (result.mode === 'denied') {
      const msg = result.reason === 'full'
        ? 'Server is at capacity. Please try again shortly.'
        : 'Session unavailable. Please refresh.';
      socket.emit('error', msg);
      socket.disconnect();
      this.conns.delete(socket.id);
      return;
    }

    // The conn is gone before its lease arrived. Superseded: a later
    // connection holds the lease now, nothing to do. Otherwise the socket
    // disconnected while the lease was being acquired and nothing owns it:
    // zombify like any disconnect, so a quick refresh restores it and the
    // grace window frees it otherwise.
    if (this.conns.get(socket.id) !== state) {
      if (state.superseded) return;
      console.log(`Session ${socket.id} left during acquire (lease ${result.lease.leaseId})`);
      this.admission.zombify(result.lease.leaseId);
      return;
    }

    state.lease = result.lease;
    state.mode = result.mode;
    socket.emit('session_status', { mode: result.mode });
    console.log(`Session ${socket.id} ${result.mode} (lease ${state.lease.leaseId})`);

    // Apply any resize/visibility that arrived during the async acquire.
    if (state.pendingResize) {
      const r = state.pendingResize;
      state.pendingResize = null;
      this.handleResize(socket.id, r.cols, r.rows);
    }
    if (state.pendingHidden !== undefined) {
      const hidden = state.pendingHidden;
      state.pendingHidden = undefined;
      this.handleVisibility(socket.id, hidden);
    }

    // A resume keeps an existing prompt; reset the initCommand gate so the
    // incoming resize repaints the URL's command into the fresh xterm.
    if (result.mode === 'resume') {
      state.promptSeen = true;
      state.firstResizeApplied = false;
      state.initCommandRun = false;
      // Cancel any script still streaming from the prior socket, then let the
      // first resize trigger _maybeRunInitCommand.
      try { this.lifecycle.write(state.lease.handleId, '\x03'); } catch { /* ignore */ }
    }

    // Safety net: a half-broken client that never sends a resize must not
    // deadlock the welcome screen. Force the gate open after 6s.
    state.resizeFallback = setTimeout(() => {
      const s = this.conns.get(socket.id);
      if (s && !s.firstResizeApplied) {
        console.warn(`Session ${socket.id}: no resize within 6s, releasing initCommand gate`);
        s.firstResizeApplied = true;
        this._maybeRunInitCommand(socket.id);
      }
    }, 6000);

    this._setSessionTimeout(socket.id);
    this._setNoInputTimeout(socket.id);
  }

  handleInput(socketId, data) {
    const state = this.conns.get(socketId);
    if (!state || !state.lease) return;
    if (typeof data !== 'string' || data.length > 1024) return;

    state.hasReceivedInput = true;
    if (state.noInputTimer) { clearTimeout(state.noInputTimer); state.noInputTimer = null; }
    this._setSessionTimeout(socketId);
    try { this.lifecycle.write(state.lease.handleId, data); } catch { /* ignore */ }
  }

  handleResize(socketId, cols, rows) {
    const state = this.conns.get(socketId);
    if (!state) return;
    if (!state.lease) { state.pendingResize = { cols, rows }; return; }

    const safeCols = Math.min(Math.max(Math.floor(cols) || 80, 10), 500);
    const safeRows = Math.min(Math.max(Math.floor(rows) || 24, 2), 200);

    this.lifecycle.resize(state.lease.handleId, safeCols, safeRows)
      .then(() => {
        if (!state.firstResizeApplied) {
          state.firstResizeApplied = true;
          this._maybeRunInitCommand(socketId);
        }
      })
      .catch((err) => {
        // Container gone (e.g. killed externally) → destroy so the client
        // reconnects to a fresh container.
        if (err && err.statusCode === 404) this._destroy(socketId);
      });
  }

  handleVisibility(socketId, hidden) {
    const state = this.conns.get(socketId);
    if (!state || typeof hidden !== 'boolean') return;
    if (!state.lease) { state.pendingHidden = hidden; return; }

    const visible = !hidden;
    if (state.pageVisible === visible) return;
    state.pageVisible = visible;
    // After the first keystroke the bot-kill timer is cancelled for good.
    if (state.hasReceivedInput) return;
    this._setNoInputTimeout(socketId);
  }

  handleDisconnect(socketId) {
    const state = this.conns.get(socketId);
    if (!state) return;
    this._clearTimers(state);
    if (state.lease) this.admission.zombify(state.lease.leaseId);
    this.conns.delete(socketId);
  }

  handleError(socketId) {
    this._destroy(socketId);
  }

  // Another connection took this conn's lease (a second tab in the same
  // browser presenting the same sessionId): the stream is already rebound, so
  // drop the conn before its disconnect zombifies — or its idle / no-input
  // timer destroys — the lease under the new tab. Tell it, and hang up so a
  // refresh there takes the lease back — but never session_end: the client
  // would drop the browser-wide sessionId and reconnect cold, evicting the tab
  // that just took over.
  _retire(socketId) {
    const s = this.conns.get(socketId);
    if (!s) return;
    console.log(`Session ${socketId} superseded${s.lease ? ` (lease ${s.lease.leaseId})` : ''}`);
    this._clearTimers(s);
    s.superseded = true;
    // Socket.IO raises `disconnect` synchronously: the conn must already be
    // gone so handleDisconnect does not zombify the lease.
    this.conns.delete(socketId);
    try { s.socket.emit('output', '\r\n[session moved to a newer tab — refresh here to take it back]\r\n'); } catch { /* ignore */ }
    try { s.socket.disconnect(); } catch { /* ignore */ }
  }

  // Run the initCommand only once the prompt has appeared AND the first resize
  // has been applied — so welcome/nvim/blog render at the real viewport size.
  _maybeRunInitCommand(socketId) {
    const state = this.conns.get(socketId);
    if (!state || !state.lease) return;
    if (state.initCommandRun) return;
    if (!state.promptSeen || !state.firstResizeApplied) return;

    // Empty-string initCommand is a deliberate no-op sentinel (the blog cold
    // page already shows content and has the user typing).
    if (state.initCommand === '') { state.initCommandRun = true; return; }

    state.initCommandRun = true;
    // boot === welcome: the intro animation + welcome content is a single
    // flow and replays on EVERY connect, including resume/refresh (both the
    // animation and the welcome typewriter are keypress-skippable).
    const cmd = state.initCommand || 'boot';
    setTimeout(() => this._autoType(socketId, cmd), 20);
  }

  _autoType(socketId, command) {
    const state = this.conns.get(socketId);
    if (!state || !state.lease) return;
    if (!command || typeof command !== 'string') command = 'welcome';
    // Char whitelist — matches the frontend allowlist. Blocks shell metachars.
    if (!/^[a-z0-9 ._/+=:,@-]+$/i.test(command) || command.length > 200) {
      console.warn(`Rejected initCommand for ${socketId} — falling back to boot`);
      command = 'boot';
    }

    const { handleId } = state.lease;
    const socket = state.socket;

    // `welcome` is typed char-by-char so the user sees it being entered; other
    // commands (long slugs, blog lookups) are sent atomically.
    if (command === 'welcome') {
      try { socket.emit('tti', { phase: 'welcome-start' }); } catch { /* ignore */ }
      const chars = [...command];
      const perCharMs = 20;
      chars.forEach((ch, i) => {
        setTimeout(() => {
          if (this.conns.has(socketId)) {
            try { this.lifecycle.write(handleId, ch); } catch { /* ignore */ }
          }
        }, i * perCharMs);
      });
      setTimeout(() => {
        if (this.conns.has(socketId)) {
          try { this.lifecycle.write(handleId, '\r'); } catch { /* ignore */ }
          try { socket.emit('tti', { phase: 'welcome-enter-sent' }); } catch { /* ignore */ }
        }
      }, chars.length * perCharMs + 80);
      return;
    }

    try { this.lifecycle.write(handleId, command + '\r'); } catch { /* ignore */ }
  }

  _setSessionTimeout(socketId) {
    const state = this.conns.get(socketId);
    if (!state) return;
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      const s = this.conns.get(socketId);
      if (!s) return;
      console.log(`Session ${socketId} timed out (idle ${this.sessionTimeout / 1000}s)`);
      const sock = s.socket;
      this._destroy(socketId);
      if (sock) {
        try { sock.emit('output', '\r\n[session idle — closed]\r\n'); } catch { /* ignore */ }
        try { sock.disconnect(); } catch { /* ignore */ }
      }
    }, this.sessionTimeout);
  }

  _setNoInputTimeout(socketId) {
    const state = this.conns.get(socketId);
    if (!state) return;
    if (state.noInputTimer) clearTimeout(state.noInputTimer);
    const timeout = state.pageVisible === true
      ? this.noInputTimeoutVisible
      : this.noInputTimeout;
    state.noInputTimer = setTimeout(() => {
      const s = this.conns.get(socketId);
      if (!s || s.hasReceivedInput) return;
      console.log(`Session ${socketId} closed (no input within ${timeout / 1000}s)`);
      const sock = s.socket;
      this._destroy(socketId);
      if (sock) { try { sock.disconnect(); } catch { /* ignore */ } }
    }, timeout);
  }

  _handleStreamClose(socketId) {
    // The container stream died (e.g. user typed `exit`). End the session so the
    // client reconnects to a fresh terminal.
    const state = this.conns.get(socketId);
    if (!state) return;
    const sock = state.socket;
    try { sock.emit('output', '\r\n\x1b[2m[session ended — refresh for a new terminal]\x1b[0m\r\n'); } catch { /* ignore */ }
    try { sock.emit('session_end'); } catch { /* ignore */ }
    this._destroy(socketId);
  }

  _destroy(socketId) {
    const state = this.conns.get(socketId);
    if (!state) return;
    this._clearTimers(state);
    const leaseId = state.lease && state.lease.leaseId;
    this.conns.delete(socketId);
    if (leaseId) this.admission.destroy(leaseId).catch(() => {});
  }

  _clearTimers(state) {
    if (state.timeout) clearTimeout(state.timeout);
    if (state.noInputTimer) clearTimeout(state.noInputTimer);
    if (state.resizeFallback) clearTimeout(state.resizeFallback);
    state.timeout = state.noInputTimer = state.resizeFallback = null;
  }

  // --- lifecycle/maintenance surface (names kept stable for server.js) ---

  startPoolMaintenance() {
    if (this._maintTimer) return;
    this._maintTimer = setInterval(() => {
      this.lifecycle.reclaimOrphans().catch(() => {});
      this.admission.pruneStaleRateLimits();
    }, 60 * 1000);
  }

  cleanupOrphanedContainers() {
    return this.lifecycle.reclaimOrphans().catch(() => {});
  }

  getActiveSessionCount() {
    return this.conns.size;
  }

  getTotalContainerCount() {
    return this.conns.size;
  }

  async destroyAllSessions() {
    const ids = Array.from(this.conns.keys());
    for (const id of ids) {
      const s = this.conns.get(id);
      this._clearTimers(s);
      if (s && s.lease) await this.admission.destroy(s.lease.leaseId).catch(() => {});
    }
    this.conns.clear();
    console.log('All sessions destroyed');
  }
}

module.exports = SessionManager;
