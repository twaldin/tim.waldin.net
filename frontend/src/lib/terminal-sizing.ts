// Font size picks the terminal grid: cols and rows fall out of FitAddon, so
// these functions choose the font that makes the grid come out right.

export interface TerminalGrid {
  cols: number;
  rows: number;
}

const MOBILE_BREAKPOINT = 768;
const MIN_FONT_SIZE = 10;
export const MIN_EMBED_FONT_SIZE = 8;
const MIN_TOUR_FONT_SIZE = 6;
const MAX_FONT_SIZE = 28;
// JetBrains Mono Nerd Font Mono: 600/1000 em advance, 1020 + 300 em line box.
const CHAR_WIDTH_RATIO = 0.6;
const ROW_HEIGHT_RATIO = 1.32;
// Terminal.tsx pads its host 14px on each side.
const HOST_PADDING_X = 28;
// FitAddon keeps this much for xterm's scrollbar even where scrollbars overlay.
const SCROLLBAR_WIDTH = 15;

const clampFontSize = (min: number, size: number) => Math.max(min, Math.min(MAX_FONT_SIZE, size));

// xterm snaps a cell to whole device pixels: the width down, the height up.
const cellWidth = (fontSize: number, dpr: number) => Math.floor(fontSize * CHAR_WIDTH_RATIO * dpr) / dpr;
const cellHeight = (fontSize: number, dpr: number) => Math.ceil(fontSize * ROW_HEIGHT_RATIO * dpr) / dpr;

function largestFontSize(min: number, fits: (fontSize: number) => boolean): number {
  for (let fontSize = MAX_FONT_SIZE; fontSize > min; fontSize--) {
    if (fits(fontSize)) return fontSize;
  }
  return min;
}

// Site: narrow screens get compact columns; ultrawide monitors get a bigger,
// readable font instead of wasting real estate on 200+ cols.
export function viewportFontSize(viewportWidth: number): number {
  if (viewportWidth < MOBILE_BREAKPOINT) {
    // Derive target cols from actual usable width so we never exceed what
    // the viewport can display at the minimum font size.
    const usableWidth = viewportWidth - HOST_PADDING_X;
    const targetCols = Math.max(40, Math.min(80, Math.floor(usableWidth / (MIN_FONT_SIZE * CHAR_WIDTH_RATIO))));
    return clampFontSize(MIN_FONT_SIZE, Math.floor(usableWidth / (targetCols * CHAR_WIDTH_RATIO)));
  }
  return clampFontSize(MIN_FONT_SIZE, Math.round(viewportWidth / 80));
}

// Live /x embed: at least 64 cols from 440 px up and 50 below (the welcome box needs 40).
export function embedMinCols(viewportWidth: number): number {
  return viewportWidth >= 440 ? 64 : 50;
}

// The first guess for the live embed's font; Terminal steps it down if the
// fitted grid still comes out narrower than embedMinCols.
export function embedLiveFontSize(viewportWidth: number, dpr: number): number {
  const minCols = embedMinCols(viewportWidth);
  const available = viewportWidth - HOST_PADDING_X - SCROLLBAR_WIDTH;
  return largestFontSize(MIN_EMBED_FONT_SIZE, (fontSize) => Math.floor(available / cellWidth(fontSize, dpr)) >= minCols);
}

// A fixed grid (the recorded /x tour): the largest font at which all of it fits the box.
export function gridFontSize(width: number, height: number, grid: TerminalGrid, dpr: number): number {
  return largestFontSize(MIN_TOUR_FONT_SIZE, (fontSize) =>
    grid.cols * cellWidth(fontSize, dpr) <= width - SCROLLBAR_WIDTH
    && grid.rows * cellHeight(fontSize, dpr) <= height);
}
