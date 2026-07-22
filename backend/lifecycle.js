'use strict';

// Underspecified choices: construction starts warming immediately; operations on an
// unknown handle throw, except destroy (idempotent); pre-resize and teardown are
// best-effort, matching the behavior of the previous SessionManager.

const {
  SESSION_LABEL_KEY,
  SESSION_LABEL_VALUE,
  buildContainerSpec,
  labelFilter,
} = require('./sandbox-policy');

/**
 * @typedef {object} SessionHandle
 * @property {string} handleId opaque, equal to the container id
 * @property {boolean} inAltScreen alternate-screen tracking for restore on rebind
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

const ATTACH_OPTIONS = Object.freeze({
  stream: true,
  stdin: true,
  stdout: true,
  stderr: true,
  hijack: true,
});
const PREAMBLE_PREFIX = '{"stream":true';
const ALT_SCREEN_REPLAY = '\x1b[?1049h\x1b[2J\x1b[H';
const ALT_SCREEN_SEQUENCE = /\x1b\[\?(?:1049|47)([hl])/g;

/** The id-oriented adapter over dockerode used outside tests. */
class DockerodeAdapter {
  constructor() {
    const Docker = require('dockerode');
    const dockerOptions = {};

    if (process.env.DOCKER_HOST) {
      const hostParts = process.env.DOCKER_HOST.replace('tcp://', '').split(':');
      dockerOptions.host = hostParts[0];
      dockerOptions.port = parseInt(hostParts[1]) || 2375;
    }

    this.docker = new Docker(dockerOptions);
    this.containers = new Map();
  }

  ping() {
    return this.docker.ping();
  }

  async create(spec) {
    const container = await this.docker.createContainer(spec);
    const id = container.id || container.Id;
    this.containers.set(id, container);
    return id;
  }

  start(id) {
    return this._container(id).start();
  }

  attach(id) {
    return this._container(id).attach(ATTACH_OPTIONS);
  }

  resize(id, dimensions) {
    return this._container(id).resize(dimensions);
  }

  kill(id) {
    return this._container(id).kill();
  }

  async remove(id, { force } = {}) {
    try {
      return await this._container(id).remove({ force });
    } finally {
      this.containers.delete(id);
    }
  }

  list(options) {
    return this.docker.listContainers(options);
  }

  listImages() {
    return this.docker.listImages();
  }

  getImage(id) {
    return this.docker.getImage(id);
  }

  pruneImages(filters) {
    return this.docker.pruneImages(filters);
  }

  pruneContainers() {
    return this.docker.pruneContainers();
  }

  _container(id) {
    let container = this.containers.get(id);
    if (!container) {
      container = this.docker.getContainer(id);
      this.containers.set(id, container);
    }
    return container;
  }
}

class SessionLifecycle {
  constructor({ docker, poolSize = 5 } = {}) {
    this.docker = docker || new DockerodeAdapter();
    this.poolSize = Math.max(0, poolSize);
    this.pool = [];
    this.poolWarming = 0;
    this.handles = new Map();

    this._fillPool();
  }

  /**
   * Lease a prepared container and bind it to the current output sink.
   * @param {string} sessionId
   * @param {{onOutput: function(string): void, onClose: function(): void}} callbacks
   * @returns {Promise<SessionHandle>}
   */
  async lease(sessionId, callbacks) {
    const pooled = this._takeFromPool();
    let prepared;

    if (pooled) {
      prepared = pooled;
    } else {
      prepared = await this._createPrepared(sessionId);
    }

    const handle = { handleId: prepared.id, inAltScreen: false };
    const record = {
      handle,
      stream: prepared.stream,
      dataHandler: null,
      closeHandler: null,
      preamblePending: true,
      preambleBuffer: '',
      escapeTail: '',
    };
    this.handles.set(handle.handleId, record);

    try {
      this.bindStream(handle, prepared.stream, callbacks);
      // Stop the warming capture and replay the buffered prompt/output through
      // the freshly bound sink (via the same preamble-filter + alt-screen path).
      if (prepared.warmDataHandler) {
        prepared.stream.off('data', prepared.warmDataHandler);
        prepared.warmDataHandler = null;
      }
      if (prepared.buffer && prepared.buffer.length) {
        const record = this.handles.get(handle.handleId);
        for (const chunk of prepared.buffer) {
          if (record && record.dataHandler) record.dataHandler(chunk);
        }
        prepared.buffer = [];
      }
    } catch (error) {
      this.handles.delete(handle.handleId);
      await this._teardownPrepared(prepared);
      throw error;
    } finally {
      this._fillPool();
    }

    return handle;
  }

  /** Replace the callbacks attached to a live handle's existing stream. */
  rebind(handleId, callbacks) {
    const record = this._record(handleId);
    this.bindStream(record.handle, record.stream, callbacks);
    if (record.handle.inAltScreen) callbacks.onOutput(ALT_SCREEN_REPLAY);
    return record.handle;
  }

  write(handleId, input) {
    return this._record(handleId).stream.write(input);
  }

  resize(handleId, cols, rows) {
    this._record(handleId);
    return this.docker.resize(handleId, { h: rows, w: cols });
  }

  async destroy(handleId) {
    const record = this.handles.get(handleId);
    if (!record) return false;

    this.handles.delete(handleId);
    this._unbindStream(record);
    try {
      record.stream.end();
    } catch {
      // A closed hijacked stream needs no further teardown.
    }
    await this._killAndRemove(handleId);
    return true;
  }

  capacityUsed() {
    return this.handles.size + this.pool.length;
  }

  /**
   * Reclaim only portfolio-labeled containers that are neither active nor pooled.
   * This deliberately does not call either Docker prune endpoint.
   */
  async reclaimOrphans() {
    const filters = labelFilter();
    const containers = await this.docker.list({ all: true, filters });
    const retained = new Set(this.handles.keys());
    for (const item of this.pool) retained.add(item.id);

    for (const info of containers) {
      const id = info.Id || info.ID || info.id;
      const labels = info.Labels || info.labels || {};
      if (!id || retained.has(id)) continue;
      if (labels[SESSION_LABEL_KEY] !== SESSION_LABEL_VALUE) continue;

      try {
        await this.docker.kill(id);
      } catch {
        // Stopped containers reject kill but still need removal.
      }
      await this.docker.remove(id, { force: true, filters: labelFilter() });
    }
  }

  /**
   * The sole stream-forwarding wiring point. Rebinding always replaces both
   * listeners instead of stacking another forwarding closure.
   */
  bindStream(handle, stream, { onOutput, onClose }) {
    const record = this._record(handle.handleId);
    this._unbindStream(record);

    record.dataHandler = (data) => {
      const output = this._withoutAttachPreamble(record, data.toString());
      if (!output) return;
      this._trackAltScreen(record, output);
      onOutput(output);
    };
    record.closeHandler = () => onClose();
    stream.on('data', record.dataHandler);
    stream.on('close', record.closeHandler);
  }

  _fillPool() {
    while (this.pool.length + this.poolWarming < this.poolSize) {
      this.poolWarming++;
      this._warmOne().then(
        () => {
          this.poolWarming--;
          // If a lease consumed this container between pool.push() and this
          // continuation, immediately refill the newly visible gap.
          this._fillPool();
        },
        () => {
          // A later lease or pool-stream close retries; avoid an unbounded hot loop.
          this.poolWarming--;
        },
      );
    }
  }

  async _warmOne() {
    const prepared = await this._createPrepared('pool');
    const pooled = {
      ...prepared,
      alive: true,
      closeHandler: null,
      warmDataHandler: null,
      buffer: [],
    };
    // Capture output rendered while warming (the zsh prompt) so it can be
    // replayed through the real sink the instant a visitor leases this
    // container — otherwise the pre-rendered prompt is lost (no sink yet).
    pooled.warmDataHandler = (data) => {
      if (pooled.alive) pooled.buffer.push(data.toString());
    };
    pooled.stream.on('data', pooled.warmDataHandler);
    pooled.closeHandler = () => {
      pooled.alive = false;
      if (pooled.warmDataHandler) pooled.stream.off('data', pooled.warmDataHandler);
      this.pool = this.pool.filter((item) => item !== pooled);
      this._fillPool();
    };
    pooled.stream.on('close', pooled.closeHandler);
    this.pool.push(pooled);
  }

  _takeFromPool() {
    while (this.pool.length) {
      const pooled = this.pool.shift();
      pooled.stream.off('close', pooled.closeHandler);
      if (pooled.alive && !pooled.stream.destroyed) return pooled;
    }
    return null;
  }

  async _createPrepared(sessionId) {
    const id = await this.docker.create(buildContainerSpec(sessionId));
    let stream;
    try {
      await this.docker.start(id);
      try {
        await this.docker.resize(id, { h: 40, w: 140 });
      } catch {
        // The initial 140x40 resize is a best-effort fallback.
      }
      stream = await this.docker.attach(id);
      return { id, stream };
    } catch (error) {
      await this._killAndRemove(id);
      throw error;
    }
  }

  async _teardownPrepared(prepared) {
    try {
      prepared.stream.end();
    } catch {
      // Ignore an already-closed stream.
    }
    await this._killAndRemove(prepared.id);
  }

  async _killAndRemove(id) {
    try {
      await this.docker.kill(id);
    } catch {
      // Kill is expected to fail when a container already stopped.
    }
    try {
      await this.docker.remove(id, { force: true, filters: labelFilter() });
    } catch {
      // Destruction is idempotent even if Docker already removed the container.
    }
  }

  _record(handleId) {
    const record = this.handles.get(handleId);
    if (!record) throw new Error(`unknown session handle: ${handleId}`);
    return record;
  }

  _unbindStream(record) {
    if (record.dataHandler) record.stream.off('data', record.dataHandler);
    if (record.closeHandler) record.stream.off('close', record.closeHandler);
    record.dataHandler = null;
    record.closeHandler = null;
  }

  _withoutAttachPreamble(record, text) {
    if (!record.preamblePending) return text;

    record.preambleBuffer += text;
    const candidate = record.preambleBuffer;
    if (candidate.length < PREAMBLE_PREFIX.length && PREAMBLE_PREFIX.startsWith(candidate)) {
      return '';
    }
    if (candidate.startsWith(PREAMBLE_PREFIX)) {
      const end = candidate.indexOf('}');
      if (end === -1) return '';
      record.preamblePending = false;
      record.preambleBuffer = '';
      return candidate.slice(end + 1);
    }

    record.preamblePending = false;
    record.preambleBuffer = '';
    return candidate;
  }

  _trackAltScreen(record, output) {
    const searchable = record.escapeTail + output;
    ALT_SCREEN_SEQUENCE.lastIndex = 0;
    let match;
    while ((match = ALT_SCREEN_SEQUENCE.exec(searchable)) !== null) {
      record.handle.inAltScreen = match[1] === 'h';
    }
    record.escapeTail = searchable.slice(-7);
  }
}

SessionLifecycle.DockerodeAdapter = DockerodeAdapter;
SessionLifecycle.ATTACH_OPTIONS = ATTACH_OPTIONS;

module.exports = SessionLifecycle;
