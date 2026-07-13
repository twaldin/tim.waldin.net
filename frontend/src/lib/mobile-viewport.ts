export type PromptVisibleScrollTarget = {
  cursorLine: number;
  viewportTop: number;
  rows: number;
  bottomMarginRows?: number;
};

export type ElementVisibilityScrollDelta = {
  elementTop: number;
  elementBottom: number;
  visibleTop: number;
  visibleBottom: number;
  topMargin?: number;
  bottomMargin?: number;
};

export type TerminalDimensions = {
  cols: number;
  rows: number;
};

const DEFAULT_PROMPT_BOTTOM_MARGIN_ROWS = 3;

export function getPromptVisibleScrollTarget({
  cursorLine,
  viewportTop,
  rows,
  bottomMarginRows = DEFAULT_PROMPT_BOTTOM_MARGIN_ROWS,
}: PromptVisibleScrollTarget): number {
  if (rows <= 0) return Math.max(0, viewportTop);
  const safeMargin = Math.max(1, Math.min(bottomMarginRows, rows - 1));
  const desiredBottom = viewportTop + rows - 1 - safeMargin;

  if (cursorLine > desiredBottom) {
    return Math.max(0, cursorLine - rows + 1 + safeMargin);
  }

  if (cursorLine < viewportTop) {
    return Math.max(0, cursorLine - safeMargin);
  }

  return Math.max(0, viewportTop);
}

export function getScrollDeltaToKeepElementVisible({
  elementTop,
  elementBottom,
  visibleTop,
  visibleBottom,
  topMargin = 0,
  bottomMargin = 0,
}: ElementVisibilityScrollDelta): number {
  const comfortableTop = visibleTop + Math.max(0, topMargin);
  const comfortableBottom = visibleBottom - Math.max(0, bottomMargin);

  if (elementBottom > comfortableBottom) {
    return Math.ceil(elementBottom - comfortableBottom);
  }

  if (elementTop < comfortableTop) {
    return Math.floor(elementTop - comfortableTop);
  }

  return 0;
}

export function shouldEmitTerminalResize(
  previous: TerminalDimensions | null,
  next: TerminalDimensions,
): boolean {
  return previous === null || previous.cols !== next.cols || previous.rows !== next.rows;
}
