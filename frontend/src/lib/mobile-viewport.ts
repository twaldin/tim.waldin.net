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

const KEYBOARD_INSET_NOISE_FLOOR_PX = 24;

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
