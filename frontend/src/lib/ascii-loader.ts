export const ASCII_LOADER_TEXT = 'connecting to container';
export const COLD_LOADER_PHRASES = [
  ASCII_LOADER_TEXT,
  'attaching pty',
  'allocating sandbox',
  'warming shell',
  'loading portfolio',
  'preparing terminal',
  'spawning session',
] as const;
export const RESUME_LOADER_PHRASES = [
  'resuming session',
  'reconnecting to pty',
  'restoring terminal',
  'reattaching shell',
] as const;
export const LOADER_MODES = ['cold', 'resume'] as const;
export type LoaderMode = typeof LOADER_MODES[number];

export const MAX_LOADER_TEXT_LENGTH = Math.max(
  ...COLD_LOADER_PHRASES.map((phrase) => phrase.length),
  ...RESUME_LOADER_PHRASES.map((phrase) => phrase.length),
);

export const LOADER_EXIT_HOLD_MS = 75;
export const BLOCK_SCRAMBLE_POOL = ['░', '▒', '▓', '█'] as const;
export const RANDOM_SCRAMBLE_POOL = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%_!<>/{}[]()=+-*&@#?'.split(''),
  ...BLOCK_SCRAMBLE_POOL,
] as const;

const LOADER_CONFIG = {
  cold: {
    minDecodeMs: 1000,
    phrases: COLD_LOADER_PHRASES,
  },
  resume: {
    minDecodeMs: 200,
    phrases: RESUME_LOADER_PHRASES,
  },
} as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function seededIndex(seed: number, length: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return Math.abs(Math.floor((x - Math.floor(x)) * length)) % length;
}

function revealThreshold(index: number, length: number): number {
  if (length <= 1) return 0.72;
  const center = (length - 1) / 2;
  const distanceFromCenter = Math.abs(index - center) / center;
  // Decode center-out, matching the reference's from: 'center' feel.
  return 0.68 + distanceFromCenter * 0.2;
}

export function getLoaderConfig(mode: LoaderMode = 'cold') {
  return LOADER_CONFIG[mode];
}

export function selectLoaderText(
  mode: LoaderMode = 'cold',
  randomSource: () => number = Math.random,
): string {
  const phrases = getLoaderConfig(mode).phrases;
  const index = Math.min(
    phrases.length - 1,
    Math.max(0, Math.floor(randomSource() * phrases.length)),
  );
  return phrases[index];
}

export function getLoaderHoldText(text: string, dotCount = 0): string {
  return `${text}${'.'.repeat(Math.max(0, Math.min(3, dotCount))).padEnd(3, ' ')}`;
}

export function buildScrambleDecodeFrame(
  text: string,
  phase: number,
  tick = 0,
): string {
  const progress = clamp01(phase);

  if (progress >= 0.98) return text;

  const chars = Array.from(text);
  const nonSpaceLength = chars.filter((char) => char !== ' ').length;
  let nonSpaceIndex = -1;

  return chars.map((char, index) => {
    if (char === ' ') return char;
    nonSpaceIndex += 1;

    const threshold = revealThreshold(nonSpaceIndex, nonSpaceLength);
    if (progress >= threshold) {
      const localProgress = (progress - threshold) / Math.max(0.01, 0.98 - threshold);
      const shouldHoldTarget = localProgress > 0.5 || seededIndex(index + tick * 3, 3) === 0;
      if (shouldHoldTarget) return char;
    }

    if (progress < 0.34) {
      return BLOCK_SCRAMBLE_POOL[
        seededIndex(index * 7 + tick * 5 + Math.floor(progress * 30), BLOCK_SCRAMBLE_POOL.length)
      ];
    }

    return RANDOM_SCRAMBLE_POOL[
      seededIndex(index * 11 + tick * 17 + Math.floor(progress * 60), RANDOM_SCRAMBLE_POOL.length)
    ];
  }).join('');
}
