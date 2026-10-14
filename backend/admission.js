'use strict';

// The frozen contract requires every split module to load the shared sandbox
// foundation. Admission never constructs a container spec; that authority stays
// in SessionLifecycle.
require('./sandbox-policy');
const { SESSION_KINDS } = require('./session-kinds');

/**
 * Contract notes for underspecified mechanics:
 * - tryAcquire has no caller-supplied socket/lease id, so Admission generates an
 *   opaque process-local id and passes it to SessionLifecycle as the session id.
 * - The injectable clock is callable (Date.now-compatible). Tests may additionally
 *   provide clock.setTimeout/clock.clearTimeout; native timers are the fallback.
 * - The caller's sinks travel with tryAcquire: onOutput / onClose are bound to
 *   the container stream (a lifecycle close destroys the lease), and
 *   onSuperseded is remembered on the lease so a later restore or eviction
 *   can retire the connection it displaces.
 */

/**
 * @typedef {object} SessionHandle
 * @property {string} handleId opaque, equal to the container id
 * @property {boolean} inAltScreen alt-screen tracking for restore on rebind
 */

/**
 * @typedef {object} Lease
 * @property {string} leaseId equal to the socket id
 * @property {string} handleId references a SessionHandle
 * @property {string} ip
 * @property {'site'|'embed'} kind selects the IP policy in SESSION_KINDS
 * @property {string} [persistentId]
 * @property {'pending'|'active'|'zombie'|'ended'} state
 * @property {number} acquiredAt
 * @property {number} lastActivity
 */

const ZOMBIE_GRACE_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONNECTIONS_PER_IP = 30;

const ipKey = (kind, ip) => `${kind} ${ip}`;

class Admission {
  constructor({ lifecycle, maxSessions = 40, clock = Date.now, kinds = SESSION_KINDS }) {
    if (!lifecycle) throw new TypeError('lifecycle is required');
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new RangeError('maxSessions must be a positive integer');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.lifecycle = lifecycle;
    this.maxSessions = maxSessions;
    this.clock = clock;
    this.kinds = kinds;

    this.pendingLeases = new Map();
    this.activeLeases = new Map();
    this.zombieLeases = new Map();
    this.ipLeases = new Map();
    this.pendingOperations = new Map();
    this.connectionTracker = new Map();
    this.nextLeaseId = 1;

    this.setTimer = typeof clock.setTimeout === 'function'
      ? clock.setTimeout.bind(clock)
      : setTimeout;
    this.clearTimer = typeof clock.clearTimeout === 'function'
      ? clock.clearTimeout.bind(clock)
      : clearTimeout;
  }

  /**
   * Acquire a new lease or resume a persistent one. The sinks belong to the
   * calling connection: `onOutput` / `onClose` are bound to the container
   * stream; `onSuperseded` fires synchronously when a later connection
   * resumes this lease or evicts it to take the IP.
   * @param {string} ip
   * @param {{kind?: 'site'|'embed', persistentId?: string, initCommand?: string,
   *   onOutput?: function(string): void, onClose?: function(): void,
   *   onSuperseded?: function(): void}} options
   * @returns {Promise<{mode: 'cold'|'resume', lease: Lease}|{mode: 'denied', reason: string}>}
   */
  async tryAcquire(ip, { kind = 'site', persistentId, initCommand, onOutput, onClose, onSuperseded } = {}) {
    // Command execution is deliberately outside the frozen lifecycle interface.
    // Accept it here so the public Admission signature remains exact.
    void initCommand;

    if (persistentId) {
      const persistentLease = this._findPersistentLease(persistentId, kind);
      if (persistentLease) {
        if (persistentLease.ip !== ip) {
          return { mode: 'denied', reason: 'ip-mismatch' };
        }
        return this._restore(persistentLease, { onOutput, onClose, onSuperseded });
      }
      const pendingLease = this.kinds[kind].ip.mode === 'share'
        ? this._findPendingLease(persistentId, kind)
        : null;
      if (pendingLease) {
        if (pendingLease.ip !== ip) return { mode: 'denied', reason: 'ip-mismatch' };
        await pendingLease.settled;
        return this.tryAcquire(ip, { kind, persistentId, initCommand, onOutput, onClose, onSuperseded });
      }
    }

    const ipPolicy = this.kinds[kind].ip;
    let eviction;
    if (ipPolicy.mode === 'replace') {
      const existingLeaseId = this.ipLeases.get(ipKey(kind, ip));
      if (existingLeaseId) eviction = this._evict(existingLeaseId);
    } else if (this._countOnIp(ip, kind) >= ipPolicy.maxPerIp) {
      return { mode: 'denied', reason: 'ip-cap' };
    }
    if (!eviction && this._capacityUsed() >= this.maxSessions) {
      // H6: no await occurs between this check and the pendingLeases entry
      // below, so concurrent tryAcquire calls cannot overshoot maxSessions.
      return { mode: 'denied', reason: 'full' };
    }

    const now = this.clock();
    const leaseId = `lease-${now}-${this.nextLeaseId++}`;
    let settle;
    /** @type {Lease} */
    const lease = {
      leaseId,
      handleId: '',
      ip,
      kind,
      persistentId,
      onOutput,
      onClose,
      onSuperseded,
      state: 'pending',
      acquiredAt: now,
      lastActivity: now,
      settled: new Promise((resolve) => { settle = resolve; }),
    };

    this.pendingLeases.set(leaseId, lease);
    if (ipPolicy.mode === 'replace') this.ipLeases.set(ipKey(kind, ip), leaseId);

    try {
      if (eviction) {
        try {
          await eviction;
        } catch {
          this._endPendingLease(lease);
          return { mode: 'denied', reason: 'eviction-failed' };
        }
        if (lease.state !== 'pending') return { mode: 'denied', reason: 'cancelled' };
      }

      const operation = this._fulfillLease(lease);
      this.pendingOperations.set(leaseId, operation);
      try {
        return await operation;
      } finally {
        if (this.pendingOperations.get(leaseId) === operation) {
          this.pendingOperations.delete(leaseId);
        }
      }
    } finally {
      settle();
    }
  }

  /**
   * Move an active lease into its 30-second reconnect grace period. The lease
   * keeps its visitor slot (and container) until it is restored or expires.
   */
  zombify(leaseId) {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;

    this.activeLeases.delete(leaseId);
    this._releaseIp(lease);
    lease.state = 'zombie';
    lease.lastActivity = this.clock();

    if (this.kinds[lease.kind].ip.mode === 'replace') {
      for (const [existingId, entry] of this.zombieLeases) {
        if (entry.lease.ip !== lease.ip || entry.lease.kind !== lease.kind) continue;
        this.clearTimer(entry.timer);
        this.zombieLeases.delete(existingId);
        entry.lease.state = 'ended';
        void this.lifecycle.destroy(entry.lease.handleId).catch(() => {});
        break;
      }
    }

    let timer;
    const expire = () => {
      const current = this.zombieLeases.get(leaseId);
      if (!current || current.timer !== timer) return false;
      return this.destroy(leaseId).catch(() => false);
    };
    timer = this.setTimer(expire, ZOMBIE_GRACE_MS);
    this.zombieLeases.set(leaseId, { lease, timer });
    return true;
  }

  /** Revoke the old connection's authority before tearing down its handle. */
  _evict(leaseId) {
    const lease = this.pendingLeases.get(leaseId) || this.activeLeases.get(leaseId);
    try { lease?.onSuperseded?.(); } catch { /* caller sink failure is non-fatal */ }
    return this.destroy(leaseId);
  }

  /**
   * End a lease and destroy its lifecycle handle.
   * @returns {Promise<boolean>} whether a lease existed
   */
  async destroy(leaseId) {
    let lease = this.pendingLeases.get(leaseId);
    if (lease) {
      this.pendingLeases.delete(leaseId);
    } else {
      lease = this.activeLeases.get(leaseId);
      if (lease) {
        this.activeLeases.delete(leaseId);
      } else {
        const zombie = this.zombieLeases.get(leaseId);
        if (zombie) {
          lease = zombie.lease;
          this.clearTimer(zombie.timer);
          this.zombieLeases.delete(leaseId);
        }
      }
    }

    if (!lease) return false;

    this._releaseIp(lease);
    lease.state = 'ended';

    const pendingOperation = this.pendingOperations.get(leaseId);
    if (pendingOperation) {
      // _fulfillLease observes state === ended and destroys a late-arriving
      // handle itself, so replacement acquisitions cannot overlap containers.
      await pendingOperation;
      return true;
    }

    if (lease.handleId) {
      await this.lifecycle.destroy(lease.handleId);
    }
    return true;
  }

  /** Rolling-window connection limiter shared by every admission path. */
  checkConnectionRate(ip) {
    const now = this.clock();
    const timestamps = (this.connectionTracker.get(ip) || [])
      .filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (timestamps.length >= MAX_CONNECTIONS_PER_IP) {
      this.connectionTracker.set(ip, timestamps);
      return false;
    }

    timestamps.push(now);
    this.connectionTracker.set(ip, timestamps);
    return true;
  }

  /** Drop IPs whose connection window has fully elapsed so the tracker can't grow unbounded. */
  pruneStaleRateLimits() {
    const now = this.clock();
    for (const [ip, timestamps] of this.connectionTracker) {
      const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (fresh.length === 0) this.connectionTracker.delete(ip);
      else this.connectionTracker.set(ip, fresh);
    }
  }

  /** Active and reconnect-grace leases whose writable layers need monitoring. */
  leasesForMaintenance() {
    return [
      ...this.activeLeases.values(),
      ...[...this.zombieLeases.values()].map(({ lease }) => lease),
    ];
  }

  /**
   * Visitor sessions holding a slot: leases still acquiring a container, active
   * leases and zombies in their grace window. Warm spares are never counted.
   */
  _capacityUsed() {
    return this.pendingLeases.size + this.activeLeases.size + this.zombieLeases.size;
  }

  _countOnIp(ip, kind) {
    const holders = [
      ...this.pendingLeases.values(),
      ...this.activeLeases.values(),
      ...[...this.zombieLeases.values()].map(({ lease }) => lease),
    ];
    return holders.filter((lease) => lease.ip === ip && lease.kind === kind).length;
  }

  _releaseIp(lease) {
    const key = ipKey(lease.kind, lease.ip);
    if (this.ipLeases.get(key) === lease.leaseId) this.ipLeases.delete(key);
  }

  _findPendingLease(persistentId, kind) {
    for (const lease of this.pendingLeases.values()) {
      if (lease.persistentId === persistentId && lease.kind === kind) return lease;
    }
    return null;
  }

  _findPersistentLease(persistentId, kind) {
    for (const lease of this.activeLeases.values()) {
      if (lease.persistentId === persistentId && lease.kind === kind) return lease;
    }
    for (const { lease } of this.zombieLeases.values()) {
      if (lease.persistentId === persistentId && lease.kind === kind) return lease;
    }
    return null;
  }

  async _restore(lease, { onOutput, onClose, onSuperseded }) {
    if (lease.state === 'zombie') {
      const zombie = this.zombieLeases.get(lease.leaseId);
      if (!zombie) return { mode: 'denied', reason: 'not-found' };

      this.clearTimer(zombie.timer);
      this.zombieLeases.delete(lease.leaseId);
      // Reactivate synchronously so the lease never leaves the session count.
      lease.state = 'active';
      this.activeLeases.set(lease.leaseId, lease);

      if (this.kinds[lease.kind].ip.mode === 'replace') {
        const key = ipKey(lease.kind, lease.ip);
        const otherLeaseId = this.ipLeases.get(key);
        this.ipLeases.set(key, lease.leaseId);
        if (otherLeaseId && otherLeaseId !== lease.leaseId) {
          void this._evict(otherLeaseId).catch(() => {});
        }
      }
    }

    lease.lastActivity = this.clock();
    // This call's own sinks, never fields on the shared lease: the restore that
    // rebinds is the one that hands the lease over. rebind is synchronous, and
    // the previous holder is told in the same tick, so nothing can observe it
    // still owning the lease after the stream changed hands.
    try {
      this.lifecycle.rebind(lease.handleId, this._callbacksFor(lease.leaseId, onOutput, onClose));
    } catch {
      return { mode: 'denied', reason: 'rebind-failed' };
    }
    const superseded = lease.onSuperseded;
    lease.onSuperseded = onSuperseded;
    try { superseded?.(); } catch { /* caller sink failure is non-fatal */ }
    return { mode: 'resume', lease };
  }

  async _fulfillLease(lease) {
    let handle;
    try {
      handle = await this.lifecycle.lease(
        lease.leaseId,
        this._callbacksFor(lease.leaseId, lease.onOutput, lease.onClose),
      );
    } catch {
      this._endPendingLease(lease);
      return { mode: 'denied', reason: 'lease-failed' };
    }

    lease.handleId = handle.handleId;
    if (
      lease.state !== 'pending'
      || this.pendingLeases.get(lease.leaseId) !== lease
    ) {
      await this.lifecycle.destroy(handle.handleId);
      return { mode: 'denied', reason: 'cancelled' };
    }

    this.pendingLeases.delete(lease.leaseId);
    lease.state = 'active';
    lease.lastActivity = this.clock();
    this.activeLeases.set(lease.leaseId, lease);
    return { mode: 'cold', lease };
  }

  _endPendingLease(lease) {
    if (this.pendingLeases.get(lease.leaseId) === lease) {
      this.pendingLeases.delete(lease.leaseId);
    }
    this._releaseIp(lease);
    lease.state = 'ended';
  }

  _callbacksFor(leaseId, onOutput, onClose) {
    return {
      onOutput: onOutput || (() => {}),
      onClose: () => {
        try { onClose?.(); } catch { /* caller sink failure is non-fatal */ }
        void this.destroy(leaseId).catch(() => {});
      },
    };
  }
}

module.exports = { Admission };
