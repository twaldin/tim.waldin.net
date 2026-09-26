// The desk's screens. The pixel-matrix display shows the visitor's real
// local time; the phone's always-on lock screen only a status-bar time, over
// a now-playing card and a stack of notifications (two big clocks side by
// side read as a copy); the macro pad
// its key icons. room.glb carries their display glass as the `rt_clockFace`,
// `rt_phoneScreen` and `rt_deckKeys` meshes (UV (0,0) at the viewer's
// bottom-left; the pad has one face per key, each mapping its cell of the
// canvas); each gets a small canvas as its emissive map, redrawn only
// when what it shows changes. They stay glossy black glass otherwise, so the
// room panorama and the lamp still glint on them. Room disposal frees them
// with the rest of the glTF tree.
import { CanvasTexture, Mesh, MeshStandardMaterial, SRGBColorSpace, type Object3D, type Texture } from 'three';

export interface DeskDevices {
  // `nowMs` is Date.now(); `day` 0 = night, 1 = day.
  update(nowMs: number, day: number): void;
  // The room panorama the glass reflects, at the scene's intensity (set as
  // each screen's own envMap: three scales only that by envMapIntensity).
  setEnvironment(environment: Texture | null, intensity: number): void;
}

// Glass over a lit display mirrors the room faintly: at full strength the
// window's reflection greyed the phone's lock screen by day.
const GLASS_REFLECTANCE = 0.35;

// Emissive strength. LEDs and LCDs hold their level by day and night (the
// room around them changes); the phone's always-on display dims in the
// dark, but stays a readable lock screen well under the monitor (at 0.055
// it read as switched off).
const BRIGHTNESS: Record<'clock' | 'phone' | 'deck', { night: number; day: number }> = {
  clock: { night: 0.75, day: 1.8 },
  phone: { night: 0.11, day: 0.9 },
  deck: { night: 1.5, day: 1.1 },
};

// Canvas sizes follow the quads' aspect ratios (0.108 × 0.054 m, 0.0684 ×
// 0.1454 m, and the pad's 5 × 3 grid of 20.5 mm key cells).
const CLOCK_SIZE = [512, 256] as const;
const PHONE_SIZE = [256, 544] as const;
const DECK_SIZE = [500, 300] as const;

// The display's 32 × 16 LED grid, one pitch for everything it shows: the
// time (one LED per font pixel) and the graph (the time drawn 2 × 2 on a
// finer grid read as doubled rows beside the graph's single dots).
const LED_COLUMNS = 32;
const LED_ROWS = 16;
const LED_OFF = '#0d0d0f';
// A warm white a little under full: brighter, the time's dots bloomed
// fatter than the graph's and read as a coarser grid.
const LED_TIME = '#d9cfbf';
// A commit graph under the time: the last 32 days as bars up to 7 LEDs
// tall, darker green at the foot (a per-day contribution grid read as noise).
const BAR_GREENS = ['#0b3a22', '#0d6b33', '#1a8c3e', '#2fae4b', '#4cc964', '#6ee787', '#9cf3ae'];
const GRAPH_DAYS = 32;

// 5 × 7 pixel font for the time (rows top to bottom, 1 = lit).
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['0', '1', '1', '0', '1', '1', '0'],
};

// Macro-pad keys (5 × 3), as a Stream Deck's: black LCDs under clear caps,
// each a full-face Nerd Font icon in one of the room's few accents over a
// faint glow of it, with a small label (solid colour tiles read as a toy
// and outshone everything under the monitor).
const DECK_KEYS: [string, string, string][] = [
  ['\uf120', 'term', '#a3d955'],
  ['\uf126', 'git', '#a78bfa'],
  ['\uf04b', 'run', '#a3d955'],
  ['\uf131', 'mute', '#f0797a'],
  ['\uf135', 'ship', '#5cc8e0'],
  ['\uf188', 'debug', '#f0b35a'],
  ['\uf058', 'tests', '#a3d955'],
  ['\uf121', 'code', '#a78bfa'],
  ['\uf0f4', 'break', '#e5e2dc'],
  ['\uf186', 'focus', '#a78bfa'],
  ['\uf023', 'lock', '#e5e2dc'],
  ['\uf028', 'vol', '#5cc8e0'],
  ['\uf073', 'cal', '#5cc8e0'],
  ['\uf0eb', 'idea', '#f0b35a'],
  ['\uf013', 'prefs', '#e5e2dc'],
];
// The lock screen's now-playing card: track, progress, and previous / pause /
// next in Nerd Font glyphs.
const NOW_PLAYING = {
  title: 'Midnight Commits',
  artist: 'lo-fi beats to code to',
  progress: 0.42,
  controls: ['\uf048', '\uf04c', '\uf051'],
};
// Lock-screen notifications: title, body, icon tile colour, Nerd Font icon.
const PHONE_NOTIFICATIONS: [string, string, string, string][] = [
  ['CI passed', 'main · all checks green', '#2ea043', '\uf00c'],
  ['Review requested', '#67 · first-person room', '#8250df', '\uf126'],
  ['Standup', 'Tomorrow, 10:00', '#d1242f', '\uf073'],
];
const DECK_FONT = '"JetBrainsMono Nerd Font Mono", monospace';

const twelveHour = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true;

function timeText(date: Date) {
  const hours = date.getHours();
  return `${twelveHour ? hours % 12 || 12 : hours}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function surface(mesh: Mesh, size: readonly [number, number]) {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas unavailable');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false; // glTF UV convention
  texture.anisotropy = 4;
  const material = new MeshStandardMaterial({
    color: '#000000',
    roughness: 0.08,
    metalness: 0,
    emissive: '#ffffff',
    emissiveMap: texture,
  });
  mesh.material = material;
  return { context, texture, material };
}

// A deterministic 0–1 hash of an integer (a day number).
function hash(n: number) {
  let x = Math.imul(n ^ 0x2f6b1d, 0x9e3779b1);
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  return ((x ^ (x >>> 13)) >>> 0) / 2 ** 32;
}

// Commits on a day (days since the epoch): busier on weekdays, in streaks
// of about a week, 0–7 LEDs tall; the chart scrolls a column a day.
function commitBar(day: number) {
  const weekday = (day + 4) % 7 !== 0 && (day + 4) % 7 !== 6; // 1 Jan 1970 was a Thursday
  const activity = (0.55 * hash(day) + 0.45 * hash(Math.floor(day / 7) + 7919)) * (weekday ? 1 : 0.45);
  return Math.min(7, Math.round(activity * 8.5));
}

function drawClock(context: CanvasRenderingContext2D, date: Date) {
  const [width, height] = CLOCK_SIZE;
  const pitch = width / LED_COLUMNS;
  const leds: string[] = new Array<string>(LED_COLUMNS * LED_ROWS).fill(LED_OFF);
  // The time in rows 1–7, one LED per font pixel.
  const text = timeText(date);
  const widths = [...text].map((char) => GLYPHS[char]?.[0].length ?? 0);
  let column = Math.round((LED_COLUMNS - (widths.reduce((a, b) => a + b, 0) + (text.length - 1))) / 2);
  for (const [i, char] of [...text].entries()) {
    GLYPHS[char]?.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '1') leds[(1 + y) * LED_COLUMNS + column + x] = LED_TIME;
    });
    column += widths[i] + 1;
  }
  // The graph in rows 9–15, today at the right.
  const today = Math.floor((date.getTime() - date.getTimezoneOffset() * 60000) / 86400000);
  for (let col = 0; col < GRAPH_DAYS; col++) {
    const bar = commitBar(today - (GRAPH_DAYS - 1 - col));
    for (let k = 0; k < bar; k++) leds[(15 - k) * LED_COLUMNS + col] = BAR_GREENS[k];
  }
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  // Round dots with dark gaps between them, as on a real matrix.
  const gap = pitch * 0.16;
  for (let row = 0; row < LED_ROWS; row++) {
    for (let col = 0; col < LED_COLUMNS; col++) {
      context.fillStyle = leds[row * LED_COLUMNS + col];
      context.beginPath();
      context.roundRect(col * pitch + gap, row * pitch + gap, pitch - 2 * gap, pitch - 2 * gap, pitch * 0.34);
      context.fill();
    }
  }
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  context.beginPath();
  context.roundRect(x, y, w, h, r);
}

function drawPhone(context: CanvasRenderingContext2D, date: Date) {
  const [width, height] = PHONE_SIZE;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.save();
  roundedRect(context, 0, 0, width, height, 33);
  context.clip();
  // Dimmed wallpaper: deep blue with soft violet and teal glows.
  const base = context.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, '#0b1030');
  base.addColorStop(1, '#05060f');
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);
  for (const [cx, cy, radius, color] of [
    [width * 0.15, height * 0.72, width * 0.9, 'rgba(120, 60, 220, 0.55)'],
    [width * 0.95, height * 0.42, width * 0.75, 'rgba(20, 140, 190, 0.45)'],
    [width * 0.5, height * 1.02, width * 0.7, 'rgba(230, 90, 150, 0.35)'],
  ] as const) {
    const glow = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }
  // Dynamic Island.
  context.fillStyle = '#000000';
  roundedRect(context, width / 2 - 34, 14, 68, 20, 10);
  context.fill();

  // Status bar: the time on the left, signal and battery on the right.
  context.textAlign = 'left';
  context.fillStyle = 'rgba(255, 255, 255, 0.92)';
  context.font = '600 15px system-ui, -apple-system, sans-serif';
  context.fillText(timeText(date), 24, 30);
  for (let bar = 0; bar < 4; bar++) {
    roundedRect(context, width - 86 + bar * 6, 26 - 4 - bar * 2.5, 4, 4 + bar * 2.5, 1);
    context.fill();
  }
  context.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  context.lineWidth = 1.5;
  roundedRect(context, width - 54, 17, 26, 13, 4);
  context.stroke();
  roundedRect(context, width - 52, 19, 17, 9, 2.5);
  context.fill();

  // Now playing: album art, track, progress and controls.
  const cardTop = 58;
  context.fillStyle = 'rgba(255, 255, 255, 0.14)';
  roundedRect(context, 12, cardTop, width - 24, 124, 20);
  context.fill();
  const art = context.createLinearGradient(24, cardTop + 12, 84, cardTop + 72);
  art.addColorStop(0, '#f97316');
  art.addColorStop(0.5, '#db2777');
  art.addColorStop(1, '#4338ca');
  context.fillStyle = art;
  roundedRect(context, 24, cardTop + 12, 60, 60, 10);
  context.fill();
  context.fillStyle = 'rgba(255, 255, 255, 0.95)';
  context.font = '600 15px system-ui, -apple-system, sans-serif';
  context.fillText(NOW_PLAYING.title, 96, cardTop + 36);
  context.fillStyle = 'rgba(255, 255, 255, 0.65)';
  context.font = '400 13px system-ui, -apple-system, sans-serif';
  context.fillText(NOW_PLAYING.artist, 96, cardTop + 56);
  context.fillStyle = 'rgba(255, 255, 255, 0.22)';
  roundedRect(context, 24, cardTop + 86, width - 48, 4, 2);
  context.fill();
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  roundedRect(context, 24, cardTop + 86, (width - 48) * NOW_PLAYING.progress, 4, 2);
  context.fill();
  context.textAlign = 'center';
  context.font = `20px ${DECK_FONT}`;
  for (const [i, icon] of NOW_PLAYING.controls.entries()) context.fillText(icon, width / 2 + (i - 1) * 56, cardTop + 116);

  // Notifications: the build that just went green, a review request and
  // tomorrow's standup.
  for (const [i, [title, body, tint, icon]] of PHONE_NOTIFICATIONS.entries()) {
    const top = 196 + i * 68;
    context.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundedRect(context, 12, top, width - 24, 58, 16);
    context.fill();
    context.fillStyle = tint;
    roundedRect(context, 22, top + 12, 34, 34, 8);
    context.fill();
    context.textAlign = 'center';
    context.fillStyle = '#ffffff';
    context.font = `18px ${DECK_FONT}`;
    context.fillText(icon, 39, top + 35);
    context.textAlign = 'left';
    context.fillStyle = 'rgba(255, 255, 255, 0.95)';
    context.font = '600 13px system-ui, -apple-system, sans-serif';
    context.fillText(title, 66, top + 25);
    context.fillStyle = 'rgba(255, 255, 255, 0.7)';
    context.font = '400 12px system-ui, -apple-system, sans-serif';
    context.fillText(body, 66, top + 43);
  }

  // Flashlight and camera buttons, home indicator.
  const buttonY = height - 58;
  context.fillStyle = 'rgba(255, 255, 255, 0.14)';
  for (const cx of [44, width - 44]) {
    context.beginPath();
    context.arc(cx, buttonY, 21, 0, Math.PI * 2);
    context.fill();
  }
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  // Flashlight: a head over a slim body.
  roundedRect(context, 44 - 6, buttonY - 10, 12, 6, 1.5);
  context.fill();
  roundedRect(context, 44 - 3.5, buttonY - 3, 7, 13, 1.5);
  context.fill();
  // Camera: a body with a lens cut out.
  roundedRect(context, width - 44 - 11, buttonY - 7, 22, 15, 3);
  context.fill();
  context.fillStyle = 'rgba(40, 40, 60, 1)';
  context.beginPath();
  context.arc(width - 44, buttonY + 0.5, 4.5, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = 'rgba(255, 255, 255, 0.8)';
  roundedRect(context, width / 2 - 50, height - 14, 100, 5, 2.5);
  context.fill();
  context.restore();
}

function drawDeck(context: CanvasRenderingContext2D) {
  const [width, height] = DECK_SIZE;
  const cell = width / 5;
  // The LCD under each key covers 74% of the key pitch.
  const tile = cell * 0.74;
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const [i, [icon, label, color]] of DECK_KEYS.entries()) {
    const x = (i % 5) * cell + (cell - tile) / 2;
    const y = Math.floor(i / 5) * cell + (cell - tile) / 2;
    const cx = x + tile / 2;
    // Near-black LCD with a faint glow of the key's accent behind the icon.
    const glow = context.createRadialGradient(cx, y + tile * 0.42, 0, cx, y + tile * 0.42, tile * 0.62);
    glow.addColorStop(0, `${color}38`);
    glow.addColorStop(1, '#00000000');
    context.fillStyle = '#050506';
    roundedRect(context, x, y, tile, tile, tile * 0.14);
    context.fill();
    context.fillStyle = glow;
    context.fill();
    // The icon fills the face; bright enough to glow like an LCD at night.
    context.fillStyle = color;
    context.font = `${Math.round(tile * 0.56)}px ${DECK_FONT}`;
    context.fillText(icon, cx, y + tile * 0.43);
    context.fillStyle = '#9a9ea6';
    context.font = `${Math.round(tile * 0.15)}px ${DECK_FONT}`;
    context.fillText(label, cx, y + tile * 0.86);
  }
}

export function createDeskDevices(roomScene: Object3D): DeskDevices {
  const clockMesh = roomScene.getObjectByName('rt_clockFace');
  const phoneMesh = roomScene.getObjectByName('rt_phoneScreen');
  const deckMesh = roomScene.getObjectByName('rt_deckKeys');
  if (!(clockMesh instanceof Mesh) || !(phoneMesh instanceof Mesh) || !(deckMesh instanceof Mesh)) {
    throw new Error('room.glb has no rt_clockFace / rt_phoneScreen / rt_deckKeys mesh');
  }
  // The quads share the glTF's placeholder glass.
  const placeholder: unknown = clockMesh.material;
  const clock = surface(clockMesh, CLOCK_SIZE);
  const phone = surface(phoneMesh, PHONE_SIZE);
  const deck = surface(deckMesh, DECK_SIZE);
  if (placeholder instanceof MeshStandardMaterial) placeholder.dispose();
  drawDeck(deck.context);
  const screens = [
    [clock, BRIGHTNESS.clock],
    [phone, BRIGHTNESS.phone],
    [deck, BRIGHTNESS.deck],
  ] as const;

  let shownMinute = -1;
  return {
    update(nowMs, day) {
      const minute = Math.floor(nowMs / 60000);
      if (minute !== shownMinute) {
        shownMinute = minute;
        const date = new Date(nowMs);
        drawClock(clock.context, date);
        clock.texture.needsUpdate = true;
        drawPhone(phone.context, date);
        phone.texture.needsUpdate = true;
      }
      for (const [screen, level] of screens) {
        screen.material.emissiveIntensity = level.night + (level.day - level.night) * day;
      }
    },
    setEnvironment(environment, intensity) {
      for (const [screen] of screens) {
        screen.material.envMap = environment;
        screen.material.envMapIntensity = intensity * GLASS_REFLECTANCE;
      }
    },
  };
}
