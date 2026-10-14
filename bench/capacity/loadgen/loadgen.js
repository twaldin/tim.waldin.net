'use strict';

// Closed-loop visitor load against one emulated host, driven by run.sh.
// Speaks the browser client's Socket.IO protocol (frontend/src/lib/websocket.ts),
// ramps through concurrency steps, judges each step against the frozen SLOs and
// writes one JSON line per step plus a summary to --out.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { io } = require('socket.io-client');

// Judged per step. promptAddedP95Ms is connect-to-prompt after the initCommand
// minus that command's frozen unloaded time. boot and welcome take ~8 s by
// design. Memory headroom counts memory.current minus inactive file pages,
// the cAdvisor working-set convention. Active cache and kernel memory still
// count; swap, raw memory and pressure are reported separately.
const SLO = Object.freeze({
  firstOutputP95Ms: 2000,
  promptAddedP95Ms: 6000,
  echoP95Ms: 150,
  maxSessionErrors: 0,
  maxOomKills: 0,
  minMemoryHeadroom: 0.10,
});

// From 10,122 production sessions over 177 days. Commands without a share in
// the logs split the remaining 30% evenly.
const WORKLOAD = Object.freeze({
  initCommands: [['boot', 0.36], ['welcome', 0.28], ['blog', 0.17], ['about', 0.05],
    ['resume', 0.05], ['projects', 0.05], ['contact', 0.04]],
  engagedShare: 0.10,
  commandCounts: [[1, 0.55], [2, 0.20], [3, 0.12], [4, 0.13]],
  commands: [['about', 0.18], ['help', 0.18], ['ls', 0.08], ['blog', 0.07], ['welcome', 0.07],
    ['projects', 0.05], ['resume', 0.04], ['nvim', 0.03], ['clear', 0.06], ['cd', 0.06],
    ['contact', 0.06], ['theme', 0.06], ['cat README.md', 0.06]],
  thinkMedianMs: 4500,
  thinkSigma: 1.27,
  thinkCapMs: 120_000,
  firstCommandMs: 7000,
  // Median 33 s, sigma 1.3, capped below the backend's 5 min idle kill: the
  // simulated mean visitor lifetime is 64.5 s, the production mean.
  lifetimeMedianMs: 33_000,
  lifetimeSigma: 1.3,
  lifetimeCapMs: 290_000,
  typingMsPerChar: 150,
  terminal: { cols: 160, rows: 45 },
  probes: 4,
  probeIntervalMs: 2000,
  hostileKeepaliveMs: 60_000,
});

const CONNECT_TIMEOUT_MS = 5000;
const PROMPT_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const ECHO_TIMEOUT_MS = 5000;
// New visitors join a step no faster than the steady churn of 250 live
// visitors (250 / 64 s), so no ramp is a burst a real day would not see.
const MAX_SPAWN_PER_S = 4;
const MAX_LOADGEN_LAG_MS = 50;
// Median of five unloaded runs per command with the production-matched Docker
// 29.3.0/containerd 2.2.2 and pool5 on deckbox, 2026-10-14. Frozen across experiments.
const idleMs = Object.freeze({
  boot: 8054, welcome: 7626, blog: 52, about: 59, resume: 220, projects: 306, contact: 40,
});
const MAX_LOGGED_FAILURES = 20;

// The zsh prompt is ready for input: Oh My Posh's title, then zle-line-init
// enabling keypad and bracketed-paste mode. Nothing but zsh sets the title.
const PROMPT_READY = /\x1b\]0;[^\x07]*\x07\x1b\[K\x1b\[\?1h\x1b=\x1b\[\?2004h/;
// zle leaves bracketed-paste mode when it accepts a line.
const LINE_ACCEPTED = /\x1b\[\?2004l/;
const CONTAINER_ID = /containers\/([0-9a-f]{64})/;

const MEMORY_HOG = "perl -e 'open(M,\"/sys/fs/cgroup/memory.max\");$m=<M>;"
  + 'while(1){open(C,"/sys/fs/cgroup/memory.current");$c=<C>;close C;'
  + "last if $c>$m-24*2**20;push @a,\"x\"x(4*2**20)}sleep 1e9'";
const CPU_FORK_ABUSER = "zsh -fc 'for i in {1..100}; do (while :; do :; done) & done; while :; do :; done'";

function parseArgs(argv) {
  const opts = {
    url: null, steps: [], warmS: 30, measureS: 50, bisect: 0,
    seed: 1, cgroup: null, out: null, mark: null, calibrate: 0,
  };
  for (let i = 2; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    switch (key) {
      case '--url': opts.url = value; break;
      case '--steps': opts.steps = value.split(',').map(Number); break;
      case '--warm': opts.warmS = Number(value); break;
      case '--measure': opts.measureS = Number(value); break;
      case '--bisect': opts.bisect = Number(value); break;
      case '--seed': opts.seed = Number(value); break;
      case '--cgroup': opts.cgroup = value; break;
      case '--out': opts.out = value; break;
      case '--mark': opts.mark = value; break;
      case '--events': opts.events = value; break;
      case '--calibrate': opts.calibrate = Number(value); break;
      default: throw new Error(`unknown option ${key}`);
    }
  }
  if (!opts.url || !opts.steps.length || !opts.cgroup || !opts.out || !opts.events) {
    throw new Error('required: --url --steps --cgroup --out --events');
  }
  if (opts.steps.some((n) => !Number.isInteger(n) || n <= WORKLOAD.probes)) {
    throw new Error(`every step must be an integer above the ${WORKLOAD.probes} probes`);
  }
  return opts;
}

const opts = parseArgs(process.argv);
const now = () => performance.now();
const log = (msg) => process.stderr.write(`[loadgen ${(now() / 1000).toFixed(0)}s] ${msg}\n`);

let rngState = opts.seed >>> 0;
function rand() {
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss() {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
function lognormal(median, sigma, cap) {
  return Math.min(median * Math.exp(sigma * gauss()), cap);
}
function pick(table) {
  let r = rand();
  for (const [value, weight] of table) {
    r -= weight;
    if (r < 0) return value;
  }
  return table[table.length - 1][0];
}

let nextIp = 1;
function visitorIp() {
  const i = nextIp++;
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

const sessions = [];
const errors = [];
const echoes = [];
const samples = [];
const lags = [];

class SessionFailed extends Error {}

class Session {
  constructor(kind, initCommand) {
    this.kind = kind;
    this.initCommand = initCommand;
    this.t0 = now();
    this.tFirstOutput = null;
    this.tPrompt = null;
    this.tEnd = null;
    this.bytesOut = 0;
    this.bytesIn = 0;
    this.tail = '';
    this.commands = 0;
    this.failure = null;
    this.leaving = false;
    this.waiters = new Set();
    sessions.push(this);

    this.socket = io(opts.url, {
      transports: ['websocket'],
      timeout: CONNECT_TIMEOUT_MS,
      reconnection: false,
      forceNew: true,
      auth: { initCommand, sessionId: crypto.randomUUID() },
      extraHeaders: { 'x-real-ip': visitorIp() },
    });
    this.socket.once('connect', () => {
      this.socket.emit('resize', WORKLOAD.terminal);
      this.socket.emit('visibility', { hidden: false });
    });
    this.socket.on('output', (data) => this._onOutput(data));
    this.socket.on('error', (msg) => this.fail(`server error: ${msg}`));
    this.socket.on('connect_error', (err) => this.fail(`connect_error: ${err.message}`));
    this.socket.on('session_end', () => this.fail('session_end'));
    this.socket.on('disconnect', (reason) => this.fail(`disconnect: ${reason}`));
  }

  _onOutput(data) {
    if (typeof data !== 'string') return;
    const t = now();
    if (this.tFirstOutput === null) this.tFirstOutput = t;
    this.bytesOut += Buffer.byteLength(data);
    this.tail = (this.tail + data).slice(-300);
    for (const w of [...this.waiters]) {
      if (w.kind !== 'match') continue;
      w.window += data;
      const m = w.re.exec(w.window);
      if (m) this._settle(w, { t, match: m, rest: w.window.slice(m.index + m[0].length) });
      else w.window = w.window.slice(-512);
    }
  }

  _settle(w, value, error) {
    this.waiters.delete(w);
    clearTimeout(w.timer);
    if (error) w.reject(error); else w.resolve(value);
  }

  // Every wait rejects once the session fails or leaves. On timeout a labelled
  // wait fails the session; an unlabelled one resolves null.
  _wait(fields, timeoutMs, label) {
    if (this.failure || this.tEnd !== null) return Promise.reject(new SessionFailed(this.failure || 'left'));
    return new Promise((resolve, reject) => {
      const w = { ...fields, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        if (label) this.fail(`${label} timeout`);
        else this._settle(w, null);
      }, Math.max(0, timeoutMs));
      this.waiters.add(w);
    });
  }

  // The first output matching `re` after this call; `seed` is output already
  // received that may hold it.
  waitFor(re, timeoutMs, label, seed = '') {
    const m = re.exec(seed);
    if (m) return Promise.resolve({ t: now(), match: m, rest: seed.slice(m.index + m[0].length) });
    return this._wait({ kind: 'match', re, window: seed }, timeoutMs, label);
  }

  sleep(ms) {
    return this._wait({ kind: 'sleep' }, ms, null);
  }

  async waitPrompt(deadline, label, seed = '') {
    const accepted = await this.waitFor(LINE_ACCEPTED, deadline - now(), label, seed);
    return this.waitFor(PROMPT_READY, deadline - now(), label, accepted.rest);
  }

  input(data) {
    if (this.tEnd !== null) throw new SessionFailed(this.failure || 'left');
    this.bytesIn += Buffer.byteLength(data);
    this.socket.emit('input', data);
  }

  // Types `keys` one keystroke at a time; `until` is armed before the last key.
  async type(keys, until) {
    const chars = [...keys];
    for (const ch of chars.slice(0, -1)) {
      this.input(ch);
      await this.sleep(WORKLOAD.typingMsPerChar);
    }
    const done = until();
    try {
      this.input(chars[chars.length - 1]);
    } catch (err) {
      done.catch(() => {});
      throw err;
    }
    return done;
  }

  fail(reason) {
    if (this.failure || this.leaving) return;
    this.failure = reason;
    errors.push({ t: now(), kind: this.kind, reason: reason.replace(/[0-9a-f]{12,}/g, '<id>') });
    if (errors.length <= MAX_LOGGED_FAILURES) {
      log(`${this.kind} ${this.initCommand} failed after ${((now() - this.t0) / 1000).toFixed(1)}s: ${reason};`
        + ` ${this.bytesOut} bytes, ends ${JSON.stringify(this.tail)}`);
    }
    this.close();
  }

  leave() {
    this.leaving = true;
    this.close();
  }

  close() {
    if (this.tEnd !== null) return;
    this.tEnd = now();
    for (const w of [...this.waiters]) this._settle(w, null, new SessionFailed(this.failure || 'left'));
    this.socket.disconnect();
    this.socket.removeAllListeners();
    this.socket = null;
  }
}

async function runCommand(s, cmd) {
  const prompt = () => s.waitPrompt(now() + COMMAND_TIMEOUT_MS, `command ${cmd}`);
  const promptOnly = () => s.waitFor(PROMPT_READY, COMMAND_TIMEOUT_MS, `command ${cmd}`);
  if (cmd === 'nvim') {
    await s.type('nvim\r', () => s.waitFor(LINE_ACCEPTED, COMMAND_TIMEOUT_MS, 'command nvim'));
    await s.sleep(5000);
    await s.type(':q\r', promptOnly);
  } else if (cmd === 'theme') {
    await s.type('theme\r', () => s.waitFor(LINE_ACCEPTED, COMMAND_TIMEOUT_MS, 'command theme'));
    await s.sleep(3000);
    await s.type('\x1b', promptOnly);
  } else {
    await s.type(`${cmd}\r`, prompt);
  }
  s.commands++;
}

async function reachPrompt(s) {
  await s.waitPrompt(s.t0 + PROMPT_TIMEOUT_MS, 'prompt');
  s.tPrompt = now();
}

async function visitor(s) {
  const lifetime = lognormal(WORKLOAD.lifetimeMedianMs, WORKLOAD.lifetimeSigma, WORKLOAD.lifetimeCapMs);
  const engaged = rand() < WORKLOAD.engagedShare;
  const plan = [];
  if (engaged) {
    const count = pick(WORKLOAD.commandCounts);
    for (let i = 0; i < count; i++) plan.push(pick(WORKLOAD.commands));
  }
  const think = () => lognormal(WORKLOAD.thinkMedianMs, WORKLOAD.thinkSigma, WORKLOAD.thinkCapMs);
  const firstAt = s.t0 + WORKLOAD.firstCommandMs * Math.exp(0.3 * gauss());

  await reachPrompt(s);
  let next = Math.max(firstAt, now() + 500);
  for (const cmd of plan) {
    await s.sleep(next - now());
    await runCommand(s, cmd);
    next = now() + think();
  }
  const departAt = Math.max(s.t0 + lifetime, engaged ? next : now() + 1000);
  await s.sleep(departAt - now());
  s.leave();
}

async function probe(s) {
  await reachPrompt(s);
  let key = 'x';
  while (!stopping) {
    await s.sleep(WORKLOAD.probeIntervalMs * (0.8 + 0.4 * rand()));
    const sent = now();
    const echo = s.waitFor(key === 'x' ? /x/ : /\x08 \x08/, ECHO_TIMEOUT_MS, null);
    s.input(key);
    const got = await echo;
    echoes.push({ t: sent, ms: got ? got.t - sent : Infinity });
    key = key === 'x' ? '\x7f' : 'x';
  }
}

const hostileContainers = new Map();
const hostileIds = new Set();

async function hostile(s, role, attack) {
  await reachPrompt(s);
  const idShown = s.waitFor(CONTAINER_ID, COMMAND_TIMEOUT_MS, 'hostile container id');
  s.input('grep -o -m1 "containers/[0-9a-f]*" /proc/self/mountinfo\r');
  const found = await idShown;
  hostileContainers.set(role, found.match[1]);
  hostileIds.add(found.match[1]);
  await s.waitFor(PROMPT_READY, COMMAND_TIMEOUT_MS, 'hostile prompt', found.rest);
  s.input(`${attack}\r`);
  while (!stopping) {
    await s.sleep(WORKLOAD.hostileKeepaliveMs);
    s.input(' ');
  }
}

let stopping = false;
const visitors = new Set();
let admitted = 0;

function spawnVisitor() {
  const s = new Session('visitor', pick(WORKLOAD.initCommands));
  visitors.add(s);
  visitor(s).catch(() => {}).finally(() => {
    s.close();
    visitors.delete(s);
    if (!stopping && visitors.size < admitted) spawnVisitor();
  });
}

function keepAlive(kind, initCommand, flow) {
  const s = new Session(kind, initCommand);
  flow(s).catch(() => {}).finally(() => {
    s.close();
    if (!stopping) setTimeout(() => keepAlive(kind, initCommand, flow), 1000);
  });
}

function readCgroup(file) {
  return fs.readFileSync(`${opts.cgroup}/${file}`, 'utf8');
}

const [quota, period] = readCgroup('cpu.max').split(' ').map(Number);
const hostCpus = quota / period;

function keyed(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.split(' ');
    if (k) out[k] = Number(v);
  }
  return out;
}

function psiTotal(text, kind) {
  const line = text.split('\n').find((l) => l.startsWith(kind));
  return Number(/total=(\d+)/.exec(line)[1]);
}

function sample() {
  const stat = keyed(readCgroup('memory.stat'));
  const cpu = keyed(readCgroup('cpu.stat'));
  const memPressure = readCgroup('memory.pressure');
  const cpuPressure = readCgroup('cpu.pressure');
  let containers = 0;
  for (const name of fs.readdirSync(`${opts.cgroup}/docker`)) {
    if (/^[0-9a-f]{64}$/.test(name)) containers++;
  }
  const hostile = {};
  for (const [role, id] of hostileContainers) {
    try {
      const dir = `${opts.cgroup}/docker/${id}`;
      hostile[role] = {
        id,
        memory: Number(fs.readFileSync(`${dir}/memory.current`, 'utf8')),
        pids: Number(fs.readFileSync(`${dir}/pids.current`, 'utf8')),
        cpuUsec: keyed(fs.readFileSync(`${dir}/cpu.stat`, 'utf8')).usage_usec,
      };
    } catch {
      hostile[role] = null;
    }
  }
  samples.push({
    t: now(),
    current: Number(readCgroup('memory.current')),
    max: Number(readCgroup('memory.max')),
    swap: Number(readCgroup('memory.swap.current')),
    anon: stat.anon,
    file: stat.file,
    kernel: stat.kernel,
    inactiveFile: stat.inactive_file,
    oomKill: keyed(readCgroup('memory.events')).oom_kill,
    hostile,
    cpuUsec: cpu.usage_usec,
    throttledUsec: cpu.throttled_usec,
    cpuSomeUsec: psiTotal(cpuPressure, 'some'),
    memSomeUsec: psiTotal(memPressure, 'some'),
    memFullUsec: psiTotal(memPressure, 'full'),
    containers,
    visitors: visitors.size,
  });
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function ms(v) {
  if (v === null) return null;
  return Number.isFinite(v) ? Math.round(v) : 'inf';
}

async function backendUptime() {
  try {
    const res = await fetch(`${opts.url}/stats`, { signal: AbortSignal.timeout(5000) });
    return (await res.json()).uptime;
  } catch {
    return null;
  }
}

let lastUptime = 0;

function dockerEvents(start, end) {
  const text = fs.readFileSync(opts.events, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => {
      const t = event.timeNano / 1e6 - performance.timeOrigin;
      return t >= start && t < end;
    });
}

async function evaluate(n, start, mStart, end) {
  const inWindow = (t) => t >= mStart && t < end;
  // A session joins the latency sample once its verdict is settled whatever
  // happens next: started in the window and old enough to have met or missed
  // the prompt budget. Waiting for the outcome itself would favour fast ones.
  const sampled = sessions.filter((s) => s.kind === 'visitor' && s.t0 >= mStart
    && end - s.t0 >= idleMs[s.initCommand] + SLO.promptAddedP95Ms);
  const firstOutput = sampled.map((s) => (s.tFirstOutput === null ? Infinity : s.tFirstOutput - s.t0));
  const added = (s) => (s.tPrompt === null ? Infinity : s.tPrompt - s.t0 - idleMs[s.initCommand]);
  const promptAdded = sampled.map(added);
  const promptAddedByInit = {};
  for (const init of new Set(sampled.map((s) => s.initCommand))) {
    promptAddedByInit[init] = ms(quantile(sampled.filter((s) => s.initCommand === init).map(added), 0.95));
  }
  const echo = echoes.filter((e) => inWindow(e.t)).map((e) => e.ms);
  const stepErrors = errors.filter((e) => e.t >= start && e.t < end && e.kind !== 'hostile');
  const errorKinds = {};
  for (const e of stepErrors) errorKinds[e.reason] = (errorKinds[e.reason] || 0) + 1;
  const events = dockerEvents(start, end);
  if (events.some((e) => e.Action === 'die' && e.Actor.Attributes.name === 'term-backend')) {
    stepErrors.push({ reason: 'backend crashed' });
    errorKinds['backend crashed'] = 1;
  }

  const uptime = await backendUptime();
  if (uptime === null || uptime < lastUptime) {
    stepErrors.push({ reason: 'backend down or restarted' });
    errorKinds['backend down or restarted'] = 1;
  }
  lastUptime = uptime ?? 0;

  const stepSamples = samples.filter((x) => x.t >= start && x.t < end);
  const measured = stepSamples.filter((x) => inWindow(x.t));
  const first = stepSamples[0];
  const last = stepSamples[stepSamples.length - 1];
  const oomEvents = events.filter((e) => e.Action === 'oom');
  const hostileOoms = oomEvents.filter((e) => hostileIds.has(e.Actor.ID)).length;
  const oom = Math.max(oomEvents.length - hostileOoms, last.oomKill - first.oomKill - hostileOoms);
  const workingSets = measured.map((x) => x.current - x.inactiveFile);
  const headroom = Math.min(...measured.map((x) => 1 - (x.current - x.inactiveFile) / x.max));
  const m0 = measured[0];
  const m1 = measured[measured.length - 1];
  const span = (m1.t - m0.t) * 1000;
  const MiB = 1024 * 1024;

  const ended = sessions.filter((s) => s.kind === 'visitor' && s.tEnd !== null && inWindow(s.tEnd));
  const lag = lags.filter((x) => inWindow(x.t)).map((x) => x.ms);
  const firstOutputP95 = quantile(firstOutput, 0.95);
  const promptAddedP95 = quantile(promptAdded, 0.95);
  const echoP95 = quantile(echo, 0.95);
  const lagP99 = quantile(lag, 0.99) ?? 0;
  const hostileMemory = Math.min(...measured.map((x) => x.hostile.memory?.memory ?? 0));
  const hostilePids = Math.min(...measured.map((x) => x.hostile.cpu?.pids ?? 0));
  const hostileCpu = m0.hostile.cpu?.id === m1.hostile.cpu?.id
    ? ((m1.hostile.cpu?.cpuUsec ?? 0) - (m0.hostile.cpu?.cpuUsec ?? 0)) / span : 0;
  const checks = [
    ['firstOutputP95', firstOutputP95 !== null && firstOutputP95 <= SLO.firstOutputP95Ms],
    ['promptAddedP95', promptAddedP95 !== null && promptAddedP95 <= SLO.promptAddedP95Ms],
    ['echoP95', echoP95 !== null && echoP95 <= SLO.echoP95Ms],
    ['sessionErrors', stepErrors.length <= SLO.maxSessionErrors],
    ['oomKills', oom <= SLO.maxOomKills],
    ['memoryHeadroom', headroom >= SLO.minMemoryHeadroom],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    type: 'step',
    n,
    pass: failed.length === 0,
    failed,
    valid: lagP99 <= MAX_LOADGEN_LAG_MS && sampled.length > 0 && echo.length > 0
      && hostileMemory >= 480 * MiB && hostilePids >= 90,
    firstOutputP95Ms: ms(firstOutputP95),
    promptAddedP95Ms: ms(promptAddedP95),
    promptAddedP95ByInitMs: promptAddedByInit,
    echoP95Ms: ms(echoP95),
    sessionErrors: stepErrors.length,
    errorKinds,
    oomKills: oom,
    minHeadroom: Number(headroom.toFixed(3)),
    maxWorkingSetMiB: Math.round(Math.max(...workingSets) / MiB),
    maxSwapMiB: Math.round(Math.max(...measured.map((x) => x.swap)) / MiB),
    maxKernelMiB: Math.round(Math.max(...measured.map((x) => x.kernel)) / MiB),
    cpuUtil: Number(((m1.cpuUsec - m0.cpuUsec) / span / hostCpus).toFixed(3)),
    cpuThrottledShare: Number(((m1.throttledUsec - m0.throttledUsec) / span).toFixed(3)),
    cpuPressureSome: Number(((m1.cpuSomeUsec - m0.cpuSomeUsec) / span).toFixed(3)),
    memPressureSome: Number(((m1.memSomeUsec - m0.memSomeUsec) / span).toFixed(3)),
    memPressureFull: Number(((m1.memFullUsec - m0.memFullUsec) / span).toFixed(3)),
    hostileMemoryMinMiB: Math.round(hostileMemory / MiB),
    hostilePidsMin: hostilePids,
    hostileCpuCores: Number(hostileCpu.toFixed(3)),
    containersAvg: Math.round(measured.reduce((a, x) => a + x.containers, 0) / measured.length),
    visitorsAvg: Math.round(measured.reduce((a, x) => a + x.visitors, 0) / measured.length),
    samples: { sessions: sampled.length, echo: echo.length },
    sessionsStarted: sessions.filter((s) => s.kind === 'visitor' && inWindow(s.t0)).length,
    meanLifetimeS: ended.length
      ? Number((ended.reduce((a, s) => a + s.tEnd - s.t0, 0) / ended.length / 1000).toFixed(1)) : null,
    loadgenLagP99Ms: ms(lagP99),
  };
}

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

async function runStep(n) {
  const start = now();
  const target = n - WORKLOAD.probes;
  while (admitted < target) {
    admitted++;
    if (visitors.size < admitted) spawnVisitor();
    await sleep(1000 / MAX_SPAWN_PER_S);
  }
  admitted = target;
  await sleep(opts.warmS * 1000);
  const mStart = now();
  if (opts.mark) fs.writeFileSync(opts.mark, '');
  await sleep(opts.measureS * 1000);
  const result = await evaluate(n, start, mStart, now());
  fs.appendFileSync(opts.out, `${JSON.stringify(result)}\n`);
  log(`N=${n} ${result.pass ? 'PASS' : `FAIL ${result.failed.join(',')}`}${result.valid ? '' : ' INVALID'}`
    + ` first=${result.firstOutputP95Ms} added=${result.promptAddedP95Ms} echo=${result.echoP95Ms}`
    + ` errors=${result.sessionErrors} oom=${result.oomKills} headroom=${result.minHeadroom}`
    + ` cpu=${result.cpuUtil} ws=${result.maxWorkingSetMiB}MiB containers=${result.containersAvg}`);
  return result;
}


async function main() {
  fs.writeFileSync(opts.out, '');
  if (opts.calibrate) {
    const measured = {};
    for (const init of Object.keys(idleMs)) {
      const values = [];
      for (let i = 0; i < opts.calibrate; i++) {
        const s = new Session('calibration', init);
        await reachPrompt(s);
        values.push(Math.round(s.tPrompt - s.t0));
        s.leave();
        await sleep(500);
      }
      values.sort((a, b) => a - b);
      measured[init] = { samplesMs: values, medianMs: values[Math.floor(values.length / 2)] };
    }
    fs.appendFileSync(opts.out, `${JSON.stringify({ type: 'idleCalibration', frozen: false, measured })}\n`);
    stopping = true;
    for (const s of sessions) s.leave();
    await sleep(500);
    process.exit(0);
  }
  setInterval(sample, 1000).unref();
  let expected = now() + 100;
  setInterval(() => {
    const t = now();
    lags.push({ t, ms: Math.max(0, t - expected) });
    expected = t + 100;
  }, 100).unref();
  sample();
  lastUptime = (await backendUptime()) ?? 0;
  fs.appendFileSync(opts.out, `${JSON.stringify({ type: 'calibration', frozen: true, idleMs })}\n`);
  log(`frozen idle connect-to-prompt ms: ${JSON.stringify(idleMs)}`);

  keepAlive('hostile', 'welcome', (s) => hostile(s, 'memory', MEMORY_HOG));
  keepAlive('hostile', 'welcome', (s) => hostile(s, 'cpu', CPU_FORK_ABUSER));
  for (let i = 0; i < WORKLOAD.probes; i++) keepAlive('probe', 'welcome', probe);
  const floorDeadline = now() + PROMPT_TIMEOUT_MS;
  while (true) {
    sample();
    const { hostile: h } = samples.at(-1);
    if ((h.memory?.memory ?? 0) >= 480 * 2 ** 20 && (h.cpu?.pids ?? 0) >= 90) break;
    if (now() >= floorDeadline) throw new Error('hostile floor did not reach 480 MiB and 90 pids');
    await sleep(250);
  }

  const results = [];
  let lastPass = null;
  let firstFail = null;
  for (const n of opts.steps) {
    const r = await runStep(n);
    results.push(r);
    if (!r.valid) break;
    if (!r.pass) { firstFail = n; break; }
    lastPass = n;
  }
  for (let round_ = 0; round_ < opts.bisect && firstFail !== null && results.at(-1).valid; round_++) {
    const low = lastPass ?? WORKLOAD.probes;
    const mid = Math.round((low + firstFail) / 2);
    if (mid <= low || mid >= firstFail) break;
    const r = await runStep(mid);
    results.push(r);
    if (!r.valid) break;
    if (r.pass) lastPass = mid; else firstFail = mid;
  }

  stopping = true;
  const visitorSessions = sessions.filter((s) => s.kind === 'visitor');
  const firstFailing = results.find((r) => !r.pass);
  const summary = {
    type: 'summary',
    valid: results.every((r) => r.valid),
    nStar: lastPass,
    firstFailN: firstFail,
    bindingSlo: firstFailing ? firstFailing.failed : [],
    sessionsServed: visitorSessions.filter((s) => s.tPrompt !== null).length,
    sessionsStarted: visitorSessions.length,
    commandsRun: visitorSessions.reduce((a, s) => a + s.commands, 0),
    echoKeystrokes: echoes.length,
    bytesRelayed: sessions.reduce((a, s) => a + s.bytesOut + s.bytesIn, 0),
    errors: errors.filter((e) => e.kind !== 'hostile').length,
    hostileErrors: errors.filter((e) => e.kind === 'hostile').length,
    hostileContainersSeen: hostileIds.size,
  };
  fs.appendFileSync(opts.out, `${JSON.stringify(summary)}\n`);
  log(`N*=${summary.nStar} binding=${summary.bindingSlo.join(',') || 'none'} valid=${summary.valid}`);
  for (const s of sessions) s.leave();
  await sleep(500);
  process.exit(0);
}

main().catch((err) => {
  log(`fatal: ${err.stack}`);
  process.exit(1);
});
