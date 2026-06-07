export const ASCII_LOADER_TEXT = 'CONNECTING TO CONTAINER';
export const DENSITY_RAMP = ['░', '▒', '▓', '█'] as const;

const STATUS_LABELS = [
  'allocating sandbox',
  'attaching pty',
  'warming shell',
  'loading portfolio',
] as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function buildDensityTextFrame(text: string, phase: number): string {
  const progress = clamp01(phase);

  if (progress >= 0.98) {
    return text;
  }

  return Array.from(text, (char, index) => {
    if (char === ' ') return char;

    // Offset each letter so the density field travels through the phrase
    // instead of all glyphs flipping together. The sine phase creates the
    // AliGrids/clockmaker-style shimmer using only ░▒▓█ characters.
    const wave = Math.sin(progress * Math.PI * 2 + index * 0.72);
    const normalized = (wave + 1) / 2;
    const rampIndex = Math.min(
      DENSITY_RAMP.length - 1,
      Math.floor(normalized * DENSITY_RAMP.length),
    );

    return DENSITY_RAMP[rampIndex];
  }).join('');
}

export function getLoaderStatusLabel(phase: number): string {
  const progress = clamp01(phase);
  const index = Math.min(
    STATUS_LABELS.length - 1,
    Math.floor(progress * STATUS_LABELS.length),
  );
  return STATUS_LABELS[index];
}
