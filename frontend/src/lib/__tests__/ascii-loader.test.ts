import { describe, expect, it } from 'vitest';
import {
  ASCII_LOADER_TEXT,
  DENSITY_RAMP,
  buildDensityTextFrame,
  getLoaderStatusLabel,
} from '../ascii-loader';

describe('buildDensityTextFrame', () => {
  it('preserves text width and whitespace while animating density glyphs', () => {
    const frame = buildDensityTextFrame('AB CD', 0.2);

    expect(frame).toHaveLength(5);
    expect(frame[2]).toBe(' ');
    expect([...frame.replaceAll(' ', '')].every((char) => DENSITY_RAMP.includes(char))).toBe(true);
  });

  it('changes density glyphs as phase advances', () => {
    const first = buildDensityTextFrame('CONNECT', 0.1);
    const second = buildDensityTextFrame('CONNECT', 0.6);

    expect(second).not.toBe(first);
  });

  it('resolves fully to the target text at the end of the reveal', () => {
    expect(buildDensityTextFrame(ASCII_LOADER_TEXT, 1)).toBe(ASCII_LOADER_TEXT);
  });

  it('returns stable status labels by phase bucket', () => {
    expect(getLoaderStatusLabel(0)).toBe('allocating sandbox');
    expect(getLoaderStatusLabel(0.26)).toBe('attaching pty');
    expect(getLoaderStatusLabel(0.51)).toBe('warming shell');
    expect(getLoaderStatusLabel(0.76)).toBe('loading portfolio');
  });
});
