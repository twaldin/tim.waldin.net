import { describe, expect, it } from 'vitest';
import { embedLiveFontSize, gridFontSize } from '../terminal-sizing';

describe('embedLiveFontSize', () => {
  it('keeps at least 64 cols in the 480 px player card (11 px snaps to 6 px cells: 72 cols)', () => {
    expect(embedLiveFontSize(480, 1)).toBe(11);
  });

  it('keeps at least 64 cols on a 2x screen too (6.5 px cells: 67 cols)', () => {
    expect(embedLiveFontSize(480, 2)).toBe(11);
  });

  it('drops to 11 px on a 390 px phone, where 12 px snaps to 7 px cells and leaves only 49 cols', () => {
    expect(embedLiveFontSize(390, 1)).toBe(11);
  });

  it('keeps at least 50 cols below 440 px (13 px, 7 px cells: 51 cols at 400 px)', () => {
    expect(embedLiveFontSize(400, 1)).toBe(13);
  });
});

describe('gridFontSize', () => {
  it('fits the 64x30 tour into the player card terminal area', () => {
    expect(gridFontSize(452, 446, { cols: 64, rows: 30 }, 1)).toBe(10);
  });

  it('is limited by height when the box is short', () => {
    expect(gridFontSize(452, 360, { cols: 64, rows: 30 }, 1)).toBe(9);
  });

  it('goes below the live minimum so a 320 px phone shows every column of the tour', () => {
    expect(gridFontSize(292, 760, { cols: 64, rows: 30 }, 3)).toBe(7);
  });
});
