import { describe, expect, it } from 'vitest';
import {
  getPromptVisibleScrollTarget,
  getScrollDeltaToKeepElementVisible,
  shouldEmitTerminalResize,
} from '../mobile-viewport';

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
