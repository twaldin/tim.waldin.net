'use strict';

const { EventEmitter } = require('events');

class PushableStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.ended = false;
    this.destroyed = false;
  }

  write(input) {
    this.writes.push(input);
    return true;
  }

  end() {
    this.ended = true;
  }

  push(bytes) {
    if (this.destroyed) return;
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
    this.emit('data', chunk);
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

/** In-memory implementation of SessionLifecycle's Docker adapter contract. */
class LifecycleFake {
  constructor() {
    this.nextId = 1;
    this.containers = new Map();

    this.createdSpecs = [];
    this.created = [];
    this.startedIds = [];
    this.attachCalls = [];
    this.resizeCalls = [];
    this.killedIds = [];
    this.removeCalls = [];
    this.removedIds = [];
    this.listCalls = [];
    this.listImagesCalls = 0;
    this.getImageCalls = [];
    this.pruneImagesCalls = [];
    this.pruneContainersCalls = 0;
    this.pingCalls = 0;

    this.listPayload = [
      { Id: 'portfolio-orphan', State: 'exited', Labels: { app: 'terminal-portfolio' } },
      { Id: 'not-portfolio', State: 'exited', Labels: { app: 'unrelated-service' } },
    ];
    this.imagePayload = [];
  }

  async ping() {
    this.pingCalls++;
    return true;
  }

  async create(spec) {
    const id = `fake-container-${this.nextId++}`;
    const stream = new PushableStream();
    this.createdSpecs.push(spec);
    this.created.push({ id, spec, stream });
    this.containers.set(id, { id, spec, stream });
    return id;
  }

  async start(id) {
    this.startedIds.push(id);
  }

  async attach(id) {
    this.attachCalls.push(id);
    const container = this.containers.get(id);
    if (!container) throw new Error(`unknown fake container: ${id}`);
    return container.stream;
  }

  async resize(id, dimensions) {
    this.resizeCalls.push({ id, dimensions });
  }

  async kill(id) {
    this.killedIds.push(id);
  }

  async remove(id, options) {
    this.removeCalls.push({ id, options });
    this.removedIds.push(id);
    this.containers.delete(id);
  }

  async list(options) {
    this.listCalls.push(options);
    return this.listPayload;
  }

  async listImages() {
    this.listImagesCalls++;
    return this.imagePayload;
  }

  getImage(id) {
    this.getImageCalls.push(id);
    return {
      remove: async (options) => {
        this.removeCalls.push({ id, options, image: true });
      },
    };
  }

  async pruneImages(filters) {
    this.pruneImagesCalls.push(filters);
    return {};
  }

  async pruneContainers() {
    this.pruneContainersCalls++;
    return {};
  }

  streamFor(id) {
    const container = this.containers.get(id);
    if (!container) throw new Error(`unknown fake container: ${id}`);
    return container.stream;
  }

  push(id, bytes) {
    this.streamFor(id).push(bytes);
  }

  close(id) {
    this.streamFor(id).close();
  }
}

LifecycleFake.PushableStream = PushableStream;

module.exports = LifecycleFake;
