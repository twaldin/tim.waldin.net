export type VirtualKeyboardViewport = {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop?: number;
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
