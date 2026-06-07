import { describe, expect, it } from 'vitest';
import { computeVirtualKeyboardInset } from '../mobile-viewport';

describe('computeVirtualKeyboardInset', () => {
  it('returns the occluded keyboard height when visual viewport is shorter than layout viewport', () => {
    expect(computeVirtualKeyboardInset({
      layoutViewportHeight: 800,
      visualViewportHeight: 500,
      visualViewportOffsetTop: 0,
    })).toBe(300);
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
