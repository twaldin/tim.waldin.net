import { describe, expect, it } from 'vitest';
import {
  ASCII_LOADER_TEXT,
  BLOCK_SCRAMBLE_POOL,
  LOADER_EXIT_HOLD_MS,
  LOADER_PHRASES,
  MAX_LOADER_TEXT_LENGTH,
  RANDOM_SCRAMBLE_POOL,
  buildLoadingScrambleFrame,
  buildScrambleDecodeFrame,
  getLoaderHoldText,
  selectLoaderText,
} from '../ascii-loader';

describe('buildScrambleDecodeFrame', () => {
  it('starts as only dense block glyphs while preserving text width and spaces', () => {
    const frame = buildScrambleDecodeFrame('AB CD', 0.1, 3);

    expect(frame).toHaveLength(5);
    expect(frame[2]).toBe(' ');
    expect([...frame.replaceAll(' ', '')].every((char) => (BLOCK_SCRAMBLE_POOL as readonly string[]).includes(char))).toBe(true);
  });

  it('mutates through random letters, symbols, and occasional blocks in the middle phase', () => {
    const frame = buildScrambleDecodeFrame('CONNECTING', 0.5, 9);
    const nonSpaceChars = [...frame.replaceAll(' ', '')];

    expect(frame).toHaveLength('CONNECTING'.length);
    expect(frame).not.toBe('CONNECTING');
    expect(nonSpaceChars.every((char) => (RANDOM_SCRAMBLE_POOL as readonly string[]).includes(char))).toBe(true);
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

describe('loading-phase scramble', () => {
  it('keeps the target words mostly visible while loading', () => {
    const text = 'CONNECTING';
    const frame = buildLoadingScrambleFrame(text, 11);
    const matchingChars = [...frame].filter((char, index) => char === text[index]).length;

    expect(frame).toHaveLength(text.length);
    expect(frame).not.toBe(text);
    expect(matchingChars).toBeGreaterThanOrEqual(6);
  });

  it('uses random scramble characters for the non-word glitches', () => {
    const text = 'CONNECTING';
    const frame = buildLoadingScrambleFrame(text, 7);

    expect([...frame].every((char, index) => char === text[index] || (RANDOM_SCRAMBLE_POOL as readonly string[]).includes(char))).toBe(true);
  });
});

describe('loader phrases', () => {
  it('keeps a randomizable phrase pool that includes the original copy', () => {
    expect(LOADER_PHRASES).toContain(ASCII_LOADER_TEXT);
    expect(LOADER_PHRASES.length).toBeGreaterThan(3);
  });

  it('selects a phrase from the pool using a supplied random source', () => {
    expect(selectLoaderText(() => 0)).toBe(LOADER_PHRASES[0]);
    expect(selectLoaderText(() => 0.999)).toBe(LOADER_PHRASES[LOADER_PHRASES.length - 1]);
  });

  it('defines max text width for stable layout across random phrases', () => {
    expect(MAX_LOADER_TEXT_LENGTH).toBe(Math.max(...LOADER_PHRASES.map((phrase) => phrase.length)));
  });

  it('builds stable post-decode hold text with a reserved ellipsis slot', () => {
    expect(getLoaderHoldText('ATTACHING PTY')).toBe('ATTACHING PTY   ');
  });

  it('holds the final words briefly before the terminal is revealed', () => {
    expect(LOADER_EXIT_HOLD_MS).toBeGreaterThanOrEqual(50);
    expect(LOADER_EXIT_HOLD_MS).toBeLessThanOrEqual(100);
  });
});
