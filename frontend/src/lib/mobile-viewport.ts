export type VirtualKeyboardViewport = {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop?: number;
};

export type StableLayoutViewport = {
  baselineHeight: number;
  currentInnerHeight: number;
  currentVisualViewportHeight: number;
};

export type TerminalRowsForViewport = {
  visualViewportHeight: number;
  headerHeight?: number;
  verticalPadding?: number;
  keyboardInset?: number;
  lineHeight?: number;
  minRows?: number;
};

const KEYBOARD_INSET_NOISE_FLOOR_PX = 24;
const DEFAULT_TERMINAL_LINE_HEIGHT_PX = 15;
const DEFAULT_MIN_TERMINAL_ROWS = 3;

export function computeVirtualKeyboardInset({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop = 0,
}: VirtualKeyboardViewport): number {
  const occludedHeight = layoutViewportHeight - visualViewportHeight - visualViewportOffsetTop;
  if (occludedHeight < KEYBOARD_INSET_NOISE_FLOOR_PX) return 0;
  return Math.max(0, Math.round(occludedHeight));
}

export function getStableLayoutViewportHeight({
  baselineHeight,
  currentInnerHeight,
  currentVisualViewportHeight,
}: StableLayoutViewport): number {
  const viewportShrankWithKeyboard = currentInnerHeight <= currentVisualViewportHeight + KEYBOARD_INSET_NOISE_FLOOR_PX;
  if (viewportShrankWithKeyboard && baselineHeight > currentInnerHeight) {
    return baselineHeight;
  }
  return Math.max(baselineHeight, currentInnerHeight);
}

export function estimateTerminalRowsForVisualViewport({
  visualViewportHeight,
  headerHeight = 0,
  verticalPadding = 0,
  keyboardInset = 0,
  lineHeight = DEFAULT_TERMINAL_LINE_HEIGHT_PX,
  minRows = DEFAULT_MIN_TERMINAL_ROWS,
}: TerminalRowsForViewport): number {
  const usableHeight = visualViewportHeight - headerHeight - verticalPadding - keyboardInset;
  if (usableHeight <= 0) return minRows;
  return Math.max(minRows, Math.floor(usableHeight / lineHeight));
}
