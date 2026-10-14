import { describe, expect, it } from 'vitest';
import { parseTour } from '../embed-tour';

const validTour = {
  version: 1,
  cols: 64,
  rows: 30,
  frames: [[0, '❯ '], [120, 'w'], [4000, '']],
};

describe('parseTour', () => {
  it('accepts a recorded tour', () => {
    expect(parseTour(validTour)).toEqual({
      cols: 64,
      rows: 30,
      frames: [[0, '❯ '], [120, 'w'], [4000, '']],
    });
  });

  it('rejects another format version', () => {
    expect(parseTour({ ...validTour, version: 2 })).toBeNull();
  });

  it('rejects a grid that is not a positive whole size', () => {
    expect(parseTour({ ...validTour, cols: 0 })).toBeNull();
    expect(parseTour({ ...validTour, rows: 29.5 })).toBeNull();
  });

  it('rejects frames that are not [delayMs, data] pairs', () => {
    expect(parseTour({ ...validTour, frames: [[0, 42]] })).toBeNull();
    expect(parseTour({ ...validTour, frames: [['0', 'a']] })).toBeNull();
    expect(parseTour({ ...validTour, frames: [[-5, 'a']] })).toBeNull();
    expect(parseTour({ ...validTour, frames: [[0, 'a', 'b']] })).toBeNull();
    expect(parseTour({ ...validTour, frames: [] })).toBeNull();
  });

  it('rejects anything that is not a tour object', () => {
    expect(parseTour(null)).toBeNull();
    expect(parseTour('{"version":1}')).toBeNull();
    expect(parseTour([validTour])).toBeNull();
  });
});
