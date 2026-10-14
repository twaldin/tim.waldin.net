#!/usr/bin/env node
// Records the /x embed's tour (frontend/public/x/tour.json) from a real
// backend over Socket.IO: welcome (intro animation skipped like a visitor's
// keypress would), then typed commands, with the output's real timings.
//
//   node scripts/record-tour.mjs --url http://localhost:3001
//
// Options: --url, --out, --cols, --rows, --commands a,b,c, --max-bytes.
// Needs `pnpm install` in frontend/ (socket.io-client is resolved from there).

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const { io } = createRequire(`${repoRoot}frontend/package.json`)('socket.io-client');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3001' },
    out: { type: 'string', default: `${repoRoot}frontend/public/x/tour.json` },
    cols: { type: 'string', default: '64' },
    rows: { type: 'string', default: '30' },
    commands: { type: 'string', default: 'welcome,projects,about' },
    'max-bytes': { type: 'string', default: String(200 * 1024) },
  },
});

const cols = Number(args.cols);
const rows = Number(args.rows);
const commands = args.commands.split(',').map((c) => c.trim()).filter(Boolean);
const maxBytes = Number(args['max-bytes']);

// Chunks closer together than this play as one frame; longer silences are
// capped so the loop never sits on a static screen.
const MERGE_MS = 30;
const MAX_DELAY_MS = 2500;
const END_HOLD_MS = 4000;
const TYPING_DELAYS_MS = [110, 85, 140, 95, 120, 75, 105, 130, 90];
// The site's private OSC codes (999x: URL sync, navigation, theme flicker and
// persistence) must not replay in the embed.
const PRIVATE_OSC = /\x1b\]999\d;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const frames = [];
let recording = false;
let lastFrameAt = null;
let lastOutputAt = Date.now();
let oscCarry = '';
let outputWaiter = null;

function record(chunk) {
  let text = oscCarry + chunk;
  oscCarry = '';
  // Hold back only an OSC still open at the chunk's end (no BEL, at most a
  // trailing ESC that may begin ST); any later ESC has already ended it.
  const open = text.lastIndexOf('\x1b]');
  if (open !== -1 && /^[^\x07\x1b]*\x1b?$/.test(text.slice(open + 2))) {
    oscCarry = text.slice(open);
    text = text.slice(0, open);
  }
  text = text.replace(PRIVATE_OSC, '');
  if (!text) return;

  const now = Date.now();
  const delay = lastFrameAt === null ? 0 : now - lastFrameAt;
  lastFrameAt = now;
  if (frames.length > 0 && delay < MERGE_MS) {
    frames[frames.length - 1][1] += text;
  } else {
    frames.push([Math.min(delay, MAX_DELAY_MS), text]);
  }
}

async function waitQuiet(quietMs, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (Date.now() - lastOutputAt >= quietMs) return;
    await sleep(50);
  }
  throw new Error(`output never went quiet for ${quietMs} ms within ${maxMs} ms`);
}

function nextOutput(maxMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no output after command')), maxMs);
    outputWaiter = () => { clearTimeout(timer); resolve(); };
  });
}

async function type(socket, text) {
  let i = 0;
  for (const ch of text) {
    socket.emit('input', ch);
    await sleep(TYPING_DELAYS_MS[i++ % TYPING_DELAYS_MS.length]);
  }
}

const socket = io(args.url, {
  transports: ['websocket'],
  reconnection: false,
  // '' is the backend's no-op initCommand: no boot animation on connect.
  auth: { initCommand: '', sessionId: randomUUID() },
});

const ready = new Promise((resolve, reject) => {
  socket.on('connect_error', (error) => reject(new Error(`connect failed: ${error.message}`)));
  socket.on('session_denied', (payload) => reject(new Error(`denied: ${JSON.stringify(payload)}`)));
  socket.on('session_status', resolve);
});

socket.on('connect', () => {
  socket.emit('resize', { cols, rows });
  socket.emit('visibility', { hidden: false });
});
socket.on('output', (data) => {
  lastOutputAt = Date.now();
  if (outputWaiter) { const done = outputWaiter; outputWaiter = null; done(); }
  if (recording) record(data);
});

try {
  await ready;
  await waitQuiet(1500, 20_000);

  recording = true;
  socket.emit('input', '\x0c');
  await waitQuiet(800, 10_000);

  for (const command of commands) {
    await sleep(1200);
    await type(socket, command);
    await sleep(350);
    const firstOutput = nextOutput(10_000);
    socket.emit('input', '\r');
    if (command === 'welcome') {
      await firstOutput;
      await sleep(200);
      socket.emit('input', ' ');
    }
    await waitQuiet(2000, 60_000);
  }
  frames.push([END_HOLD_MS, '']);
} finally {
  socket.disconnect();
}

const body = `{"version":1,"cols":${cols},"rows":${rows},"frames":[\n${
  frames.map((frame) => JSON.stringify(frame)).join(',\n')
}\n]}\n`;
const bytes = Buffer.byteLength(body);
if (bytes > maxBytes) {
  console.error(`tour is ${bytes} bytes, over the ${maxBytes}-byte budget; record fewer commands`);
  process.exit(1);
}
writeFileSync(args.out, body);
const durationMs = frames.reduce((sum, [delay]) => sum + delay, 0);
console.log(`wrote ${args.out}: ${frames.length} frames, ${bytes} bytes, ${(durationMs / 1000).toFixed(1)} s`);
