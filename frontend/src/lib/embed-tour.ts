// The /x tour: public/x/tour.json, recorded by scripts/record-tour.mjs.
// { version: 1, cols, rows, frames: [[delayMs, data], ...] }, where delayMs is
// the wait since the previous frame. The last frame holds the end screen.

export type TourFrame = readonly [delayMs: number, data: string];

export interface Tour {
  cols: number;
  rows: number;
  frames: readonly TourFrame[];
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isFrame = (value: unknown): value is TourFrame =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  Number.isFinite(value[0]) &&
  value[0] >= 0 &&
  typeof value[1] === 'string';

export function parseTour(raw: unknown): Tour | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, cols, rows, frames } = raw as Record<string, unknown>;
  if (version !== 1 || !isPositiveInteger(cols) || !isPositiveInteger(rows)) return null;
  if (!Array.isArray(frames) || frames.length === 0 || !frames.every(isFrame)) return null;
  return { cols, rows, frames };
}

// RIS: a blank screen with default modes, as at the start of each loop.
export const RESET = '\x1bc';

// Loops the tour forever; returns a function that stops it.
export function playTour(tour: Tour, write: (data: string) => void): () => void {
  let index = 0;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    write(index === 0 ? RESET + tour.frames[0][1] : tour.frames[index][1]);
    index = (index + 1) % tour.frames.length;
    timer = setTimeout(step, tour.frames[index][0]);
  };
  timer = setTimeout(step, tour.frames[0][0]);
  return () => clearTimeout(timer);
}
