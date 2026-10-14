
export interface TerminalGrid {
  cols: number;
  rows: number;
}

const MOBILE_BREAKPOINT = 768;
const MIN_FONT_SIZE = 10;
export const MIN_EMBED_FONT_SIZE = 8;
const MIN_TOUR_FONT_SIZE = 6;
const MAX_FONT_SIZE = 28;
// Bundled JetBrains Mono has a 0.6 em advance and a 1.32 em line box.
const CHAR_WIDTH_RATIO = 0.6;
const ROW_HEIGHT_RATIO = 1.32;
const HOST_PADDING_X = 28;
// FitAddon keeps this much for xterm's scrollbar even where scrollbars overlay.
const SCROLLBAR_WIDTH = 15;

const clampFontSize = (min: number, size: number) => Math.max(min, Math.min(MAX_FONT_SIZE, size));

// WebGL snaps cells to whole device pixels: width down, height up.
const cellWidth = (fontSize: number, dpr: number) => Math.floor(fontSize * CHAR_WIDTH_RATIO * dpr) / dpr;
const cellHeight = (fontSize: number, dpr: number) => Math.ceil(fontSize * ROW_HEIGHT_RATIO * dpr) / dpr;

function largestFontSize(min: number, fits: (fontSize: number) => boolean): number {
  for (let fontSize = MAX_FONT_SIZE; fontSize > min; fontSize--) {
    if (fits(fontSize)) return fontSize;
  }
  return min;
}

export function viewportFontSize(viewportWidth: number): number {
  if (viewportWidth < MOBILE_BREAKPOINT) {
    const usableWidth = viewportWidth - HOST_PADDING_X;
    const targetCols = Math.max(40, Math.min(80, Math.floor(usableWidth / (MIN_FONT_SIZE * CHAR_WIDTH_RATIO))));
    return clampFontSize(MIN_FONT_SIZE, Math.floor(usableWidth / (targetCols * CHAR_WIDTH_RATIO)));
  }
  return clampFontSize(MIN_FONT_SIZE, Math.round(viewportWidth / 80));
}

export function embedMinCols(viewportWidth: number): number {
  return viewportWidth >= 440 ? 64 : 50;
}

export function embedLiveFontSize(viewportWidth: number, dpr: number): number {
  const minCols = embedMinCols(viewportWidth);
  const available = viewportWidth - HOST_PADDING_X - SCROLLBAR_WIDTH;
  return largestFontSize(MIN_EMBED_FONT_SIZE, (fontSize) => Math.floor(available / cellWidth(fontSize, dpr)) >= minCols);
}

export function gridFontSize(width: number, height: number, grid: TerminalGrid, dpr: number): number {
  return largestFontSize(MIN_TOUR_FONT_SIZE, (fontSize) =>
    grid.cols * cellWidth(fontSize, dpr) <= width - SCROLLBAR_WIDTH
    && grid.rows * cellHeight(fontSize, dpr) <= height);
}
