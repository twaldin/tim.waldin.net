import { describe, expect, it } from 'vitest';
import {
  computeVirtualKeyboardInset,
  estimateTerminalRowsForVisualViewport,
  getPromptVisibleScrollTarget,
  getScrollDeltaToKeepElementVisible,
  getStableLayoutViewportHeight,
  shouldEmitTerminalResize,
} from '../mobile-viewport';

describe('computeVirtualKeyboardInset', () => {
  it('returns the occluded keyboard height when visual viewport is shorter than layout viewport', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 500,
      visualViewportOffsetTop: 0,
    })).toBe(300);
  });

  it('does not add extra inset when the keyboard already resizes content', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 520,
      visualViewportHeight: 520,
      visualViewportOffsetTop: 0,
    })).toBe(0);
  });

  it('subtracts visual viewport offset so browser chrome movement is not mistaken for keyboard overlap', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 500,
      visualViewportOffsetTop: 80,
    })).toBe(220);
  });

  it('clamps tiny or negative viewport differences to zero', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 799,
      visualViewportOffsetTop: 0,
    })).toBe(0);
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 600,
      visualViewportHeight: 700,
      visualViewportOffsetTop: 0,
    })).toBe(0);
  });

  it('does not mistake mobile browser chrome for a virtual keyboard', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 731,
      visualViewportHeight: 664,
      visualViewportOffsetTop: 0,
    })).toBe(0);
  });
});

describe('getStableLayoutViewportHeight', () => {
  it('uses the current layout height when the keyboard resizes content', () => {
    expect(getStableLayoutViewportHeight({
      baselineHeight: 800,
      currentInnerHeight: 520,
      currentVisualViewportHeight: 520,
    })).toBe(520);
  });

  it('keeps the larger pre-keyboard height when the keyboard overlays content', () => {
    expect(getStableLayoutViewportHeight({
      baselineHeight: 800,
      currentInnerHeight: 800,
      currentVisualViewportHeight: 520,
    })).toBe(800);
  });

  it('updates the baseline when the full viewport genuinely grows', () => {
    expect(getStableLayoutViewportHeight({
      baselineHeight: 800,
      currentInnerHeight: 900,
      currentVisualViewportHeight: 900,
    })).toBe(900);
  });
});

describe('estimateTerminalRowsForVisualViewport', () => {
  it('estimates rows from the keyboard-resized visual viewport', () => {
    expect(estimateTerminalRowsForVisualViewport({
      visualViewportHeight: 520,
      headerHeight: 58,
      verticalPadding: 12,
      keyboardInset: 0,
      lineHeight: 15,
    })).toBe(30);
  });

  it('keeps a minimum visible terminal even with a very tall keyboard inset', () => {
    expect(estimateTerminalRowsForVisualViewport({
      visualViewportHeight: 300,
      headerHeight: 58,
      verticalPadding: 12,
      keyboardInset: 260,
      lineHeight: 15,
      minRows: 3,
    })).toBe(3);
  });
});

describe('getPromptVisibleScrollTarget', () => {
  it('scrolls only enough to keep the prompt visible with scrollback above it', () => {
    expect(getPromptVisibleScrollTarget({
      cursorLine: 100,
      viewportTop: 80,
      rows: 18,
      bottomMarginRows: 3,
    })).toBe(86);
  });

  it('does not jump when the prompt is already comfortably visible', () => {
    expect(getPromptVisibleScrollTarget({
      cursorLine: 90,
      viewportTop: 80,
      rows: 18,
      bottomMarginRows: 3,
    })).toBe(80);
  });

  it('scrolls upward just enough when the prompt is above the viewport', () => {
    expect(getPromptVisibleScrollTarget({
      cursorLine: 40,
      viewportTop: 80,
      rows: 18,
      bottomMarginRows: 3,
    })).toBe(37);
  });
});

describe('getScrollDeltaToKeepElementVisible', () => {
  it('scrolls down only enough to reveal the prompt above the keyboard with margin', () => {
    expect(getScrollDeltaToKeepElementVisible({
      elementTop: 520,
      elementBottom: 540,
      visibleTop: 0,
      visibleBottom: 430,
      bottomMargin: 36,
    })).toBe(146);
  });

  it('does not scroll when the prompt is already comfortably visible', () => {
    expect(getScrollDeltaToKeepElementVisible({
      elementTop: 300,
      elementBottom: 320,
      visibleTop: 0,
      visibleBottom: 430,
      bottomMargin: 36,
    })).toBe(0);
  });

  it('scrolls up only enough when the prompt is pinned above the visible area', () => {
    expect(getScrollDeltaToKeepElementVisible({
      elementTop: -12,
      elementBottom: 8,
      visibleTop: 0,
      visibleBottom: 430,
      topMargin: 48,
      bottomMargin: 36,
    })).toBe(-60);
  });
});

describe('shouldEmitTerminalResize', () => {
  it('suppresses duplicate resize emissions for unchanged dimensions', () => {
    expect(shouldEmitTerminalResize({ cols: 61, rows: 26 }, { cols: 61, rows: 26 })).toBe(false);
  });

  it('emits when terminal dimensions actually change', () => {
    expect(shouldEmitTerminalResize({ cols: 61, rows: 26 }, { cols: 61, rows: 18 })).toBe(true);
    expect(shouldEmitTerminalResize(null, { cols: 61, rows: 18 })).toBe(true);
  });
});
