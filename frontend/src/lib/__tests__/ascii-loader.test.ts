import { describe, expect, it } from 'vitest';
import {
  ASCII_LOADER_TEXT,
  BLOCK_SCRAMBLE_POOL,
  RANDOM_SCRAMBLE_POOL,
  buildScrambleDecodeFrame,
} from '../ascii-loader';

describe('buildScrambleDecodeFrame', () => {
  it('starts as only dense block glyphs while preserving text width and spaces', () => {
    const frame = buildScrambleDecodeFrame('AB CD', 0.1, 3);

    expect(frame).toHaveLength(5);
    expect(frame[2]).toBe(' ');
    expect([...frame.replaceAll(' ', '')].every((char) => BLOCK_SCRAMBLE_POOL.includes(char))).toBe(true);
  });

  it('mutates through random letters, symbols, and occasional blocks in the middle phase', () => {
    const frame = buildScrambleDecodeFrame('CONNECTING', 0.5, 9);
    const nonSpaceChars = [...frame.replaceAll(' ', '')];

    expect(frame).toHaveLength('CONNECTING'.length);
    expect(frame).not.toBe('CONNECTING');
    expect(nonSpaceChars.every((char) => RANDOM_SCRAMBLE_POOL.includes(char))).toBe(true);
    expect(nonSpaceChars.some((char) => /[A-Za-z%_!]/.test(char))).toBe(true);
  });

  it('partially reveals readable target letters late in the decode', () => {
    const frame = buildScrambleDecodeFrame('CONNECTING', 0.82, 1);

    expect(frame).toHaveLength('CONNECTING'.length);
    expect(frame).not.toBe('CONNECTING');
    expect([...frame].some((char, index) => char === 'CONNECTING'[index])).toBe(true);
  });

  it('resolves fully to the target text at the end', () => {
    expect(buildScrambleDecodeFrame(ASCII_LOADER_TEXT, 1, 0)).toBe(ASCII_LOADER_TEXT);
  });
});
