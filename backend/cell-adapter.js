'use strict';

// CellAdapter: the SessionLifecycle adapter for cells. A cell is a long-lived
// container running container/cell/cellsh, which spawns one namespaced,
// cgroup-limited sandbox per unix-socket connection. Each handle is one
// connection; closing it kills the sandbox, so nothing outlives the backend
// process and there is nothing to reclaim.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Each sandbox's writable layer is a tmpfs of this size, charged to the
// sandbox's memory cgroup, so writes are bounded by size and memory limit
// instead of by the 2 s disk watchdog.
const ROOTFS_BYTES = 256 * 1024 * 1024;
const SPAWN_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 5_000;
const CPU_PERIOD_US = 100_000;
const HEADER_BYTES = 5;
const MAX_FRAME_BYTES = 1 << 20;

const GO_ARCH = { x64: 'amd64', arm64: 'arm64' };
const NATIVE_SCMP_ARCH = { amd64: 'SCMP_ARCH_X86_64', arm64: 'SCMP_ARCH_AARCH64' };

// Every container-spec field a cell knows how to enforce. Anything else in the
// spec fails the lease instead of being silently dropped.
const SPEC_KEYS = new Set(['Image', 'Hostname', 'Tty', 'OpenStdin', 'StdinOnce', 'AttachStdout',
  'AttachStderr', 'AttachStdin', 'Env', 'WorkingDir', 'User', 'Labels', 'HostConfig']);
const HOST_CONFIG_KEYS = new Set(['Memory', 'MemorySwap', 'CpuQuota', 'PidsLimit', 'ReadonlyRootfs',
  'NetworkMode', 'CapDrop', 'CapAdd', 'Tmpfs', 'LogConfig', 'SecurityOpt']);

function refuse(what) {
  throw new Error(`cell sandbox cannot enforce ${what}`);
}

function kernelAtLeast(kernel, min) {
  const [a = 0, b = 0] = kernel.split(/[.-]/).map(Number);
  const [x = 0, y = 0] = min.split('.').map(Number);
  return a > x || (a === x && b >= y);
}

function scmpAction(rule) {
  if (rule.action === 'SCMP_ACT_ALLOW') return 'allow';
  if (rule.action === 'SCMP_ACT_ERRNO') return `errno:${rule.errnoRet ?? 1}`;
  return refuse(`seccomp action ${rule.action}`);
}

function libseccompArch(scmpArch) {
  return scmpArch.replace(/^SCMP_ARCH_/, '').toLowerCase();
}

/**
 * Docker's seccomp profile -> cellsh rule lines, filtered the way moby's
 * setupSeccomp does for a container with `caps` as its bounding set.
 */
function seccompFields(profile, caps, { arch, kernel }) {
  const goArch = GO_ARCH[arch] ?? refuse(`architecture ${arch}`);
  const native = NATIVE_SCMP_ARCH[goArch];
  const fields = [`seccomp-default=${scmpAction({ action: profile.defaultAction, errnoRet: profile.defaultErrnoRet })}`];
  const entry = (profile.archMap || []).find((a) => a.architecture === native);
  for (const a of entry ? [native, ...entry.subArchitectures] : [native]) {
    fields.push(`seccomp-arch=${libseccompArch(a)}`);
  }
  for (const rule of profile.syscalls) {
    const inc = rule.includes || {};
    const exc = rule.excludes || {};
    if (exc.arches?.includes(goArch)) continue;
    if (exc.caps?.some((c) => caps.includes(c))) continue;
    if (exc.minKernel && kernelAtLeast(kernel, exc.minKernel)) continue;
    if (inc.arches?.length && !inc.arches.includes(goArch)) continue;
    if (inc.caps?.some((c) => !caps.includes(c))) continue;
    if (inc.minKernel && !kernelAtLeast(kernel, inc.minKernel)) continue;
    const action = scmpAction(rule);
    const args = (rule.args || []).map((a) => `${a.index},${a.op.replace(/^SCMP_CMP_/, '')},${a.value},${a.valueTwo ?? 0}`);
    for (const name of rule.names) fields.push(['seccomp=' + action, name, ...args].join(' '));
  }
  return fields;
}

let seccompCache = { key: null, fields: null };

/**
 * The cellsh spawn policy for a dockerode create spec (buildContainerSpec).
 * @returns {string[]} key=value fields
 */
function cellPolicy(spec, { arch = os.arch(), kernel = os.release() } = {}) {
  for (const key of Object.keys(spec)) if (!SPEC_KEYS.has(key)) refuse(key);
  const host = spec.HostConfig || {};
  for (const key of Object.keys(host)) if (!HOST_CONFIG_KEYS.has(key)) refuse(`HostConfig.${key}`);
  if (spec.Tty !== true) refuse('a non-TTY session');
  if (host.NetworkMode !== 'none') refuse(`NetworkMode ${host.NetworkMode}`);
  if (host.ReadonlyRootfs) refuse('a read-only rootfs');
  if (JSON.stringify(host.CapDrop) !== '["ALL"]') refuse('a CapDrop other than ALL');
  if (!(host.Memory > 0) || !(host.MemorySwap >= host.Memory)) refuse('memory without an explicit swap limit');
  if (!(host.CpuQuota > 0) || !(host.PidsLimit > 0)) refuse('missing CPU or pid limits');

  const caps = (host.CapAdd || []).map((c) => (c.startsWith('CAP_') ? c : `CAP_${c}`));
  const seccompOpts = (host.SecurityOpt || []).filter((o) => o.startsWith('seccomp='));
  if (seccompOpts.length !== 1 || (host.SecurityOpt || []).length !== 1) refuse('SecurityOpt other than one seccomp profile');
  const key = `${seccompOpts[0]}\n${caps.join(',')}\n${arch}\n${kernel}`;
  if (seccompCache.key !== key) {
    seccompCache = { key, fields: seccompFields(JSON.parse(seccompOpts[0].slice('seccomp='.length)), caps, { arch, kernel }) };
  }

  return [
    `hostname=${spec.Hostname}`,
    `user=${spec.User}`,
    `cwd=${spec.WorkingDir}`,
    ...(spec.Env || []).map((e) => `env=${e}`),
    `memory=${host.Memory}`,
    `swap=${host.MemorySwap - host.Memory}`,
    `cpu=${host.CpuQuota} ${CPU_PERIOD_US}`,
    `pids=${host.PidsLimit}`,
    `rootfs=${ROOTFS_BYTES}`,
    ...caps.map((c) => `cap=${c}`),
    ...Object.entries(host.Tmpfs || {}).map(([dir, opts]) => `tmpfs=${dir}:${opts}`),
    ...seccompCache.fields,
  ];
}

function frame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header[0] = type.charCodeAt(0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function notFound(id) {
  const error = new Error(`no such cell session: ${id}`);
  error.statusCode = 404;
  return error;
}

/**
 * The attach-stream shape SessionLifecycle consumes: 'data' and 'close'
 * events, write(), end(), destroyed. Output that arrives before the first
 * 'data' listener is held for it rather than dropped.
 */
class CellStream extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.destroyed = false;
    this.held = [];
    this.on('newListener', (event) => {
      if (event === 'data' && this.held.length) process.nextTick(() => this._release());
    });
  }

  write(data) {
    if (this.destroyed) return false;
    return this.socket.write(frame('I', Buffer.from(data)));
  }

  end() {
    this.socket.end();
  }

  _deliver(chunk) {
    if (this.listenerCount('data') && !this.held.length) this.emit('data', chunk);
    else this.held.push(chunk);
  }

  _release() {
    while (this.held.length && this.listenerCount('data')) this.emit('data', this.held.shift());
  }

  _closed() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

/** One connection to a cell: one sandbox. */
class CellSession {
  constructor(cell, socket) {
    this.cell = cell;
    this.socket = socket;
    this.stream = new CellStream(socket);
    this.pending = Buffer.alloc(0);
    this.usageWaiters = [];
    this.ready = null;
    this.leaf = null;
    this.oomKills = 0;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this._onClose());
  }

  static open(cell, policy) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(cell);
      const session = new CellSession(cell, socket);
      const timer = setTimeout(() => fail(new Error(`cell ${path.basename(cell)} spawn timed out`)), SPAWN_TIMEOUT_MS);
      const fail = (error) => {
        clearTimeout(timer);
        session.ready = null;
        socket.destroy();
        reject(error);
      };
      session.ready = {
        resolve: () => {
          clearTimeout(timer);
          session.ready = null;
          resolve(session);
        },
        reject: fail,
      };
      socket.once('connect', () => socket.write(frame('S', Buffer.from(`${policy.join('\0')}\0`))));
      socket.once('error', fail);
    });
  }

  _onData(chunk) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (buf.length >= HEADER_BYTES) {
      const len = buf.readUInt32BE(1);
      // cellsh never sends a frame over 64 KiB; anything larger is a broken peer.
      if (len > MAX_FRAME_BYTES) {
        this.socket.destroy();
        return;
      }
      if (buf.length < HEADER_BYTES + len) break;
      this._onFrame(String.fromCharCode(buf[0]), buf.subarray(HEADER_BYTES, HEADER_BYTES + len));
      buf = buf.subarray(HEADER_BYTES + len);
    }
    this.pending = buf.length ? Buffer.from(buf) : Buffer.alloc(0);
  }

  _onFrame(type, body) {
    switch (type) {
      case 'K':
        this.leaf = body.toString();
        this.ready?.resolve();
        break;
      case 'E':
        if (this.ready) this.ready.reject(new Error(`cell ${path.basename(this.cell)}: ${body}`));
        else console.warn(`cell ${path.basename(this.cell)} ${this.leaf}: ${body}`);
        break;
      case 'O':
        this.stream._deliver(body);
        break;
      case 'U': {
        // "<writable bytes> <oom kills so far>": a sandbox OOM shows up in the
        // backend log within one watchdog sweep, not only when the shell exits.
        const [bytes, oomKills] = body.toString().split(' ').map(Number);
        if (oomKills > this.oomKills) {
          console.warn(`cell ${path.basename(this.cell)} ${this.leaf} oom_kill ${oomKills}`);
          this.oomKills = oomKills;
        }
        this.usageWaiters.shift()?.(bytes);
        break;
      }
      case 'X': {
        const [, oomKills] = body.toString().split(' ').map(Number);
        if (oomKills > this.oomKills) console.warn(`cell ${path.basename(this.cell)} ${this.leaf} oom_kill ${oomKills} at exit`);
        break;
      }
      default:
        this.socket.destroy();
    }
  }

  _onClose() {
    this.ready?.reject(new Error(`cell ${path.basename(this.cell)} closed during spawn`));
    for (const waiter of this.usageWaiters.splice(0)) waiter(Number.NaN);
    this.stream._closed();
  }

  usage() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cell usage timed out')), USAGE_TIMEOUT_MS);
      this.usageWaiters.push((bytes) => {
        clearTimeout(timer);
        if (Number.isFinite(bytes) && bytes >= 0) resolve(bytes);
        else reject(new Error('cell reported no usage'));
      });
      this.socket.write(frame('U', Buffer.alloc(0)));
    });
  }
}

class CellAdapter {
  constructor({ socketDir = process.env.CELL_SOCKET_DIR } = {}) {
    if (!socketDir) throw new Error('CellAdapter needs a socket directory');
    this.socketDir = socketDir;
    this.sessions = new Map();
    this.load = new Map();
    this.nextId = 0;
  }

  /** Spawn a sandbox in the least-loaded reachable cell. */
  async create(spec) {
    const policy = cellPolicy(spec);
    const cells = fs.readdirSync(this.socketDir)
      .filter((name) => name.endsWith('.sock'))
      .map((name) => path.join(this.socketDir, name))
      .sort((a, b) => (this.load.get(a) ?? 0) - (this.load.get(b) ?? 0));
    let lastError = new Error(`no cell sockets in ${this.socketDir}`);
    for (const cell of cells) {
      let session;
      try {
        session = await CellSession.open(cell, policy);
      } catch (error) {
        lastError = error;
        continue;
      }
      const id = `${path.basename(cell, '.sock')}-${session.leaf}-${++this.nextId}`;
      this.sessions.set(id, session);
      this.load.set(cell, (this.load.get(cell) ?? 0) + 1);
      session.stream.once('close', () => {
        this.sessions.delete(id);
        this.load.set(cell, (this.load.get(cell) ?? 1) - 1);
      });
      return id;
    }
    throw lastError;
  }

  async start(id) {
    this._session(id);
  }

  async attach(id) {
    return this._session(id).stream;
  }

  async resize(id, { h, w }) {
    this._session(id).socket.write(frame('R', `${w} ${h}`));
  }

  async writableBytes(id) {
    return this._session(id).usage();
  }

  async kill(id) {
    this._session(id).socket.destroy();
  }

  async remove(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.socket.destroy();
  }

  // Sandboxes live exactly as long as their connection: none can be orphaned.
  async list() {
    return [];
  }

  async pruneContainers() {}

  _session(id) {
    const session = this.sessions.get(id);
    if (!session) throw notFound(id);
    return session;
  }
}

module.exports = { CellAdapter, cellPolicy, frame };
