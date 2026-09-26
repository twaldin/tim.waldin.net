// Physical 75% ANSI layout (Mac modifiers) keyed by KeyboardEvent.code, with
// the touch-typing finger that presses each key. Finger 1 is the thumb,
// 5 the little finger.

export type Hand = 'L' | 'R';
export type Finger = 1 | 2 | 3 | 4 | 5;

export interface KeyDef {
  code: string;
  width: number; // in key units (1u = 19.05 mm)
  row: number; // 0 = function row … 5 = space row
  legend: string;
  shiftLegend?: string;
  hand: Hand;
  finger: Finger;
  modifier?: boolean;
}

type RowSpec = [code: string, width: number, legend: string, shiftLegend?: string][];

const ROWS: RowSpec[] = [
  [
    ['Escape', 1, 'esc'], ['F1', 1, 'F1'], ['F2', 1, 'F2'], ['F3', 1, 'F3'], ['F4', 1, 'F4'],
    ['F5', 1, 'F5'], ['F6', 1, 'F6'], ['F7', 1, 'F7'], ['F8', 1, 'F8'], ['F9', 1, 'F9'],
    ['F10', 1, 'F10'], ['F11', 1, 'F11'], ['F12', 1, 'F12'], ['PrintScreen', 1, 'prt'],
    ['Delete', 1, 'del'], ['Insert', 1, 'ins'],
  ],
  [
    ['Backquote', 1, '`', '~'], ['Digit1', 1, '1', '!'], ['Digit2', 1, '2', '@'], ['Digit3', 1, '3', '#'],
    ['Digit4', 1, '4', '$'], ['Digit5', 1, '5', '%'], ['Digit6', 1, '6', '^'], ['Digit7', 1, '7', '&'],
    ['Digit8', 1, '8', '*'], ['Digit9', 1, '9', '('], ['Digit0', 1, '0', ')'], ['Minus', 1, '-', '_'],
    ['Equal', 1, '=', '+'], ['Backspace', 2, 'backspace'], ['Home', 1, 'home'],
  ],
  [
    ['Tab', 1.5, 'tab'], ['KeyQ', 1, 'Q'], ['KeyW', 1, 'W'], ['KeyE', 1, 'E'], ['KeyR', 1, 'R'],
    ['KeyT', 1, 'T'], ['KeyY', 1, 'Y'], ['KeyU', 1, 'U'], ['KeyI', 1, 'I'], ['KeyO', 1, 'O'],
    ['KeyP', 1, 'P'], ['BracketLeft', 1, '[', '{'], ['BracketRight', 1, ']', '}'],
    ['Backslash', 1.5, '\\', '|'], ['PageUp', 1, 'pg up'],
  ],
  [
    ['CapsLock', 1.75, 'caps lock'], ['KeyA', 1, 'A'], ['KeyS', 1, 'S'], ['KeyD', 1, 'D'],
    ['KeyF', 1, 'F'], ['KeyG', 1, 'G'], ['KeyH', 1, 'H'], ['KeyJ', 1, 'J'], ['KeyK', 1, 'K'],
    ['KeyL', 1, 'L'], ['Semicolon', 1, ';', ':'], ['Quote', 1, "'", '"'], ['Enter', 2.25, 'return'],
    ['PageDown', 1, 'pg dn'],
  ],
  [
    ['ShiftLeft', 2.25, 'shift'], ['KeyZ', 1, 'Z'], ['KeyX', 1, 'X'], ['KeyC', 1, 'C'], ['KeyV', 1, 'V'],
    ['KeyB', 1, 'B'], ['KeyN', 1, 'N'], ['KeyM', 1, 'M'], ['Comma', 1, ',', '<'], ['Period', 1, '.', '>'],
    ['Slash', 1, '/', '?'], ['ShiftRight', 1.75, 'shift'], ['ArrowUp', 1, '↑'], ['End', 1, 'end'],
  ],
  [
    ['ControlLeft', 1.25, 'control'], ['AltLeft', 1.25, 'option'], ['MetaLeft', 1.25, 'command'],
    ['Space', 6.25, ''], ['MetaRight', 1, 'cmd'], ['Fn', 1, 'fn'], ['ControlRight', 1, 'ctrl'],
    ['ArrowLeft', 1, '←'], ['ArrowDown', 1, '↓'], ['ArrowRight', 1, '→'],
  ],
];

const FINGERING: Record<string, [Hand, Finger]> = {
  Escape: ['L', 5], F1: ['L', 4], F2: ['L', 4], F3: ['L', 3], F4: ['L', 2], F5: ['L', 2],
  F6: ['R', 2], F7: ['R', 2], F8: ['R', 3], F9: ['R', 4], F10: ['R', 4], F11: ['R', 5], F12: ['R', 5],
  PrintScreen: ['R', 5], Delete: ['R', 5], Insert: ['R', 5],
  Backquote: ['L', 5], Digit1: ['L', 5], Digit2: ['L', 4], Digit3: ['L', 3], Digit4: ['L', 2],
  Digit5: ['L', 2], Digit6: ['R', 2], Digit7: ['R', 2], Digit8: ['R', 3], Digit9: ['R', 4],
  Digit0: ['R', 5], Minus: ['R', 5], Equal: ['R', 5], Backspace: ['R', 5], Home: ['R', 5],
  Tab: ['L', 5], KeyQ: ['L', 5], KeyW: ['L', 4], KeyE: ['L', 3], KeyR: ['L', 2], KeyT: ['L', 2],
  KeyY: ['R', 2], KeyU: ['R', 2], KeyI: ['R', 3], KeyO: ['R', 4], KeyP: ['R', 5],
  BracketLeft: ['R', 5], BracketRight: ['R', 5], Backslash: ['R', 5], PageUp: ['R', 5],
  CapsLock: ['L', 5], KeyA: ['L', 5], KeyS: ['L', 4], KeyD: ['L', 3], KeyF: ['L', 2], KeyG: ['L', 2],
  KeyH: ['R', 2], KeyJ: ['R', 2], KeyK: ['R', 3], KeyL: ['R', 4], Semicolon: ['R', 5], Quote: ['R', 5],
  Enter: ['R', 5], PageDown: ['R', 5],
  ShiftLeft: ['L', 5], KeyZ: ['L', 5], KeyX: ['L', 4], KeyC: ['L', 3], KeyV: ['L', 2], KeyB: ['L', 2],
  KeyN: ['R', 2], KeyM: ['R', 2], Comma: ['R', 3], Period: ['R', 4], Slash: ['R', 5],
  ShiftRight: ['R', 5], ArrowUp: ['R', 3], End: ['R', 5],
  ControlLeft: ['L', 5], AltLeft: ['L', 1], MetaLeft: ['L', 1], Space: ['R', 1], MetaRight: ['R', 1],
  Fn: ['R', 4], ControlRight: ['R', 5], ArrowLeft: ['R', 2], ArrowDown: ['R', 3], ArrowRight: ['R', 4],
};

const MODIFIERS: Record<string, true> = {
  ShiftLeft: true, ShiftRight: true, ControlLeft: true, ControlRight: true,
  AltLeft: true, MetaLeft: true, MetaRight: true, Fn: true,
};

// Codes a Mac 75% board lacks, pressed on the nearest key that exists.
export const CODE_ALIASES: Record<string, string> = {
  AltRight: 'MetaRight',
  ContextMenu: 'MetaRight',
  IntlBackslash: 'Backquote',
  NumpadEnter: 'Enter',
  ScrollLock: 'PrintScreen',
  Pause: 'Insert',
};

export const KEY_UNIT = 0.01905;
export const ROW_COUNT = ROWS.length;
// The function row sits a quarter unit apart from the rest, like most 75% boards.
export const FUNCTION_ROW_GAP = 0.25;

export interface PlacedKey extends KeyDef {
  // Key centre in board space: x right, z toward the typist, in key units.
  x: number;
  z: number;
}

export const KEYS: PlacedKey[] = ROWS.flatMap((row, rowIndex) => {
  let x = 0;
  return row.map(([code, width, legend, shiftLegend]) => {
    const [hand, finger] = FINGERING[code];
    const key: PlacedKey = {
      code,
      width,
      row: rowIndex,
      legend,
      shiftLegend,
      hand,
      finger,
      modifier: MODIFIERS[code],
      x: x + width / 2,
      z: rowIndex + (rowIndex > 0 ? FUNCTION_ROW_GAP : 0) + 0.5,
    };
    x += width;
    return key;
  });
});

export const BOARD_UNITS_WIDE = 16;
export const BOARD_UNITS_DEEP = ROW_COUNT + FUNCTION_ROW_GAP;

export const KEY_BY_CODE: Record<string, PlacedKey> = Object.fromEntries(KEYS.map((k) => [k.code, k]));

// Home-row resting key for every finger; thumbs rest on the space bar.
export const HOME_KEYS: Record<Hand, Record<Finger, string>> = {
  L: { 1: 'Space', 2: 'KeyF', 3: 'KeyD', 4: 'KeyS', 5: 'KeyA' },
  R: { 1: 'Space', 2: 'KeyJ', 3: 'KeyK', 4: 'KeyL', 5: 'Semicolon' },
};
