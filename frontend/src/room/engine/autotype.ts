// Types a command on the room keyboard at a human pace: each character is
// pressed by the hands (with Shift from the opposite hand where needed) and
// sent to the shell at the moment its key goes down. Covers every character
// the URL allowlist can produce ([A-Za-z0-9 ._/+=:,@-]).
import { KEY_BY_CODE } from './keymap';

interface Stroke {
  code: string;
  shift: boolean;
}

const SYMBOLS: Record<string, Stroke> = {
  ' ': { code: 'Space', shift: false },
  '.': { code: 'Period', shift: false },
  ',': { code: 'Comma', shift: false },
  '/': { code: 'Slash', shift: false },
  '-': { code: 'Minus', shift: false },
  '_': { code: 'Minus', shift: true },
  '=': { code: 'Equal', shift: false },
  '+': { code: 'Equal', shift: true },
  ':': { code: 'Semicolon', shift: true },
  '@': { code: 'Digit2', shift: true },
  '\r': { code: 'Enter', shift: false },
};

export function strokeFor(char: string): Stroke | null {
  if (/^[a-z]$/.test(char)) return { code: `Key${char.toUpperCase()}`, shift: false };
  if (/^[A-Z]$/.test(char)) return { code: `Key${char}`, shift: true };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, shift: false };
  return SYMBOLS[char] ?? null;
}

export interface AutoTyperKeys {
  press(code: string): void;
  release(code: string): void;
}

// Returns a cancel function. `send` receives each character as its key lands.
export function typeText(text: string, keys: AutoTyperKeys, send: (data: string) => void): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const held = new Set<string>();
  let t = 0;
  const at = (delay: number, fn: () => void) => timers.push(setTimeout(fn, delay));
  const down = (code: string) => {
    held.add(code);
    keys.press(code);
  };
  const up = (code: string) => {
    held.delete(code);
    keys.release(code);
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const stroke = strokeFor(char);
    if (!stroke) continue;
    const hand = KEY_BY_CODE[stroke.code]?.hand;
    // Shift from the hand that is not typing the character.
    const shift = hand === 'L' ? 'ShiftRight' : 'ShiftLeft';
    const start = t;
    if (stroke.shift) at(start, () => down(shift));
    const strike = start + (stroke.shift ? 70 : 0);
    at(strike, () => {
      down(stroke.code);
      send(char);
    });
    const dwell = 65 + Math.random() * 45;
    at(strike + dwell, () => up(stroke.code));
    if (stroke.shift) at(strike + dwell + 25, () => up(shift));
    // Inter-key gap: quick within a word, a beat before Enter.
    t = strike + (char === '\r' ? 0 : 95 + Math.random() * 90 + (stroke.shift ? 40 : 0));
    if (text[i + 1] === '\r') t += 220;
  }

  return () => {
    timers.forEach(clearTimeout);
    held.forEach((code) => keys.release(code));
    held.clear();
  };
}
