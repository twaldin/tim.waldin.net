import { describe, expect, it } from 'vitest';
import {
  computeVirtualKeyboardInset,
  estimateTerminalRowsForVisualViewport,
  getStableLayoutViewportHeight,
} from '../mobile-viewport';

describe('computeVirtualKeyboardInset', () => {
  it('returns the occluded keyboard height when visual viewport is shorter than layout viewport', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 500,
      visualViewportOffsetTop: 0,
    })).toBe(300);
  });

  it('can use a preserved pre-keyboard layout height when window.innerHeight shrinks too', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 520,
      visualViewportOffsetTop: 0,
    })).toBe(280);
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
});

describe('getStableLayoutViewportHeight', () => {
  it('keeps the larger pre-keyboard height when the layout viewport shrinks', () => {
    expect(getStableLayoutViewportHeight({
      baselineHeight: 800,
      currentInnerHeight: 520,
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
