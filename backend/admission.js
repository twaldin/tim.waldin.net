'use strict';

// The frozen contract requires every split module to load the shared sandbox
// foundation. Admission never constructs a container spec; that authority stays
// in SessionLifecycle.
require('./sandbox-policy');

/**
 * Contract notes for underspecified mechanics:
 * - tryAcquire has no caller-supplied socket/lease id, so Admission generates an
 *   opaque process-local id and passes it to SessionLifecycle as the session id.
 * - The injectable clock is callable (Date.now-compatible). Tests may additionally
 *   provide clock.setTimeout/clock.clearTimeout; native timers are the fallback.
 * - No transport output sink is present in Admission's public interface, so lease
 *   and rebind receive a no-op output sink. A lifecycle close destroys the lease.
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
 * @property {string} [persistentId]
 * @property {'pending'|'active'|'zombie'|'ended'} state
 * @property {number} acquiredAt
 * @property {number} lastActivity
 */

const ZOMBIE_GRACE_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONNECTIONS_PER_IP = 30;

class Admission {
  constructor({ lifecycle, maxSessions = 40, clock = Date.now }) {
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
   * Acquire a new lease or resume a persistent one.
   * @param {string} ip
   * @param {{persistentId?: string, initCommand?: string}} options
   * @returns {Promise<{mode: 'cold'|'resume', lease: Lease}|{mode: 'denied', reason: string}>}
   */
  async tryAcquire(ip, { persistentId, initCommand, onOutput, onClose } = {}) {
    // Command execution is deliberately outside the frozen lifecycle interface.
    // Accept it here so the public Admission signature remains exact.
    void initCommand;

    if (persistentId) {
      const persistentLease = this._findPersistentLease(persistentId);
      if (persistentLease) {
        if (persistentLease.ip !== ip) {
          return { mode: 'denied', reason: 'ip-mismatch' };
        }
        // Re-bind to THIS connection's output/close sinks. Without this, a
        // refresh/reattach rebinds the live container stream to the PREVIOUS
        // (now-dead) socket, so the new terminal gets session_status but no
        // output — stuck in the "reattaching" view forever.
        persistentLease.onOutput = onOutput;
        persistentLease.onClose = onClose;
        return this._restore(persistentLease);
      }
    }

    // A same-IP connection without a matching persistent id replaces that IP's
    // live lease. destroy() drops the old lease from the session count before
    // its first await, so the replacement inherits the slot; the old handle is
    // fully destroyed before lifecycle.lease starts for the replacement.
    const existingLeaseId = this.ipLeases.get(ip);
    let eviction;
    if (existingLeaseId) {
      eviction = this.destroy(existingLeaseId);
    } else if (this._capacityUsed() >= this.maxSessions) {
      // H6: no await occurs between this check and the pendingLeases entry
      // below, so concurrent tryAcquire calls cannot overshoot maxSessions.
      return { mode: 'denied', reason: 'full' };
    }

    const now = this.clock();
    const leaseId = `lease-${now}-${this.nextLeaseId++}`;
    /** @type {Lease} */
    const lease = {
      leaseId,
      handleId: '',
      ip,
      persistentId,
      onOutput,
      onClose,
      state: 'pending',
      acquiredAt: now,
      lastActivity: now,
    };

    this.pendingLeases.set(leaseId, lease);
    this.ipLeases.set(ip, leaseId);

    if (eviction) {
      try {
        await eviction;
      } catch {
        this._endPendingLease(lease);
        return { mode: 'denied', reason: 'eviction-failed' };
      }
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
  }

  /**
   * Move an active lease into its 30-second reconnect grace period. The lease
   * keeps its visitor slot (and container) until it is restored or expires.
   */
  zombify(leaseId) {
    const lease = this.activeLeases.get(leaseId);
    if (!lease) return false;

    this.activeLeases.delete(leaseId);
    if (this.ipLeases.get(lease.ip) === leaseId) {
      this.ipLeases.delete(lease.ip);
    }
    lease.state = 'zombie';
    lease.lastActivity = this.clock();

    // Preserve the old behavior of retaining at most one zombie per IP.
    for (const [existingId, entry] of this.zombieLeases) {
      if (entry.lease.ip !== lease.ip) continue;
      this.clearTimer(entry.timer);
      this.zombieLeases.delete(existingId);
      entry.lease.state = 'ended';
      void this.lifecycle.destroy(entry.lease.handleId).catch(() => {});
      break;
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

    if (this.ipLeases.get(lease.ip) === leaseId) {
      this.ipLeases.delete(lease.ip);
    }
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

  /**
   * Visitor sessions holding a slot: leases still acquiring a container, active
   * leases and zombies in their grace window. Warm spares are never counted.
   */
  _capacityUsed() {
    return this.pendingLeases.size + this.activeLeases.size + this.zombieLeases.size;
  }

  _findPersistentLease(persistentId) {
    for (const lease of this.activeLeases.values()) {
      if (lease.persistentId === persistentId) return lease;
    }
    for (const { lease } of this.zombieLeases.values()) {
      if (lease.persistentId === persistentId) return lease;
    }
    return null;
  }

  async _restore(lease) {
    if (lease.state === 'zombie') {
      const zombie = this.zombieLeases.get(lease.leaseId);
      if (!zombie) return { mode: 'denied', reason: 'not-found' };

      this.clearTimer(zombie.timer);
      this.zombieLeases.delete(lease.leaseId);
      // Reactivate before any await so the lease never leaves the session count.
      lease.state = 'active';
      this.activeLeases.set(lease.leaseId, lease);

      const otherLeaseId = this.ipLeases.get(lease.ip);
      this.ipLeases.set(lease.ip, lease.leaseId);
      if (otherLeaseId && otherLeaseId !== lease.leaseId) {
        await this.destroy(otherLeaseId);
      }
    }

    lease.lastActivity = this.clock();
    try {
      await this.lifecycle.rebind(lease.handleId, this._callbacksFor(lease.leaseId, lease.onOutput, lease.onClose));
    } catch {
      return { mode: 'denied', reason: 'rebind-failed' };
    }
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
    if (this.ipLeases.get(lease.ip) === lease.leaseId) {
      this.ipLeases.delete(lease.ip);
    }
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
