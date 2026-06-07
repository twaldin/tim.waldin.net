import { describe, expect, it } from 'vitest';
import {
  ASCII_LOADER_TEXT,
  BLOCK_SCRAMBLE_POOL,
  COLD_LOADER_PHRASES,
  LOADER_EXIT_HOLD_MS,
  LOADER_MODES,
  MAX_LOADER_TEXT_LENGTH,
  RANDOM_SCRAMBLE_POOL,
  RESUME_LOADER_PHRASES,
  buildScrambleDecodeFrame,
  getLoaderConfig,
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

describe('loader config', () => {
  it('has cold and resume modes', () => {
    expect(LOADER_MODES).toEqual(['cold', 'resume']);
    expect(COLD_LOADER_PHRASES).toContain(ASCII_LOADER_TEXT);
    expect(RESUME_LOADER_PHRASES).toContain('RESUMING SESSION');
  });

  it('uses a slower cold decode based on measured first-output time', () => {
    const cold = getLoaderConfig('cold');

    expect(cold.minDecodeMs).toBeGreaterThanOrEqual(1000);
    expect(cold.phrases).toEqual(COLD_LOADER_PHRASES);
  });

  it('uses a faster resume decode based on measured reattach time', () => {
    const resume = getLoaderConfig('resume');

    expect(resume.minDecodeMs).toBeLessThan(getLoaderConfig('cold').minDecodeMs);
    expect(resume.minDecodeMs).toBeGreaterThanOrEqual(450);
    expect(resume.phrases).toEqual(RESUME_LOADER_PHRASES);
  });

  it('selects a phrase from the requested mode pool using a supplied random source', () => {
    expect(selectLoaderText('cold', () => 0)).toBe(COLD_LOADER_PHRASES[0]);
    expect(selectLoaderText('resume', () => 0.999)).toBe(RESUME_LOADER_PHRASES[RESUME_LOADER_PHRASES.length - 1]);
  });

  it('defines max text width for stable layout across all random phrases', () => {
    expect(MAX_LOADER_TEXT_LENGTH).toBe(Math.max(
      ...COLD_LOADER_PHRASES.map((phrase) => phrase.length),
      ...RESUME_LOADER_PHRASES.map((phrase) => phrase.length),
    ));
  });

  it('builds stable post-decode hold text with a reserved ellipsis slot', () => {
    expect(getLoaderHoldText('ATTACHING PTY')).toBe('ATTACHING PTY   ');
  });

  it('holds the final words briefly before the terminal is revealed', () => {
    expect(LOADER_EXIT_HOLD_MS).toBeGreaterThanOrEqual(50);
    expect(LOADER_EXIT_HOLD_MS).toBeLessThanOrEqual(100);
  });
});
