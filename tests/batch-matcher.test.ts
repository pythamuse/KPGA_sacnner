import { describe, it, expect } from 'vitest';
import { matchBatch, describePairing, isStackOrder } from '../src/lib/recognition/batchMatcher';

const pages = (type: string, n: number) => Array.from(
  { length: n },
  (_, i) => `/tmp/${type}_page_${String(i + 1).padStart(3, '0')}.jpg`,
);

describe('matchBatch', () => {
  it('pairs the i-th of each stack when no order is given', () => {
    const cagi = pages('cagi', 3);
    const sat = pages('satisfaction', 3);
    expect(matchBatch(cagi, sat)).toEqual([
      { cagiPath: cagi[0], satisfactionPath: sat[0] },
      { cagiPath: cagi[1], satisfactionPath: sat[1] },
      { cagiPath: cagi[2], satisfactionPath: sat[2] },
    ]);
  });

  it("pairs the i-th front with the (n-1-i)-th back when the back stack is reversed", () => {
    const cagi = pages('cagi', 4);
    const sat = pages('satisfaction', 4);
    expect(matchBatch(cagi, sat, 'reversed')).toEqual([
      { cagiPath: cagi[0], satisfactionPath: sat[3] },
      { cagiPath: cagi[1], satisfactionPath: sat[2] },
      { cagiPath: cagi[2], satisfactionPath: sat[1] },
      { cagiPath: cagi[3], satisfactionPath: sat[0] },
    ]);
  });

  it('leaves the caller that passes nothing exactly where it was', () => {
    const cagi = pages('cagi', 5);
    const sat = pages('satisfaction', 5);
    expect(matchBatch(cagi, sat)).toEqual(matchBatch(cagi, sat, 'same'));
  });
  it('puts the same physical sheet on both halves when the back stack was scanned reversed', () => {
    // Sheets A..F. The fronts feed forwards, so page 1 is sheet A. The stack is
    // then turned over and fed again, so the back of sheet F comes out first.
    const sheets = ['A', 'B', 'C', 'D', 'E', 'F'];
    const cagi = pages('cagi', 6);
    const sat = pages('satisfaction', 6);
    const frontSheet = new Map(cagi.map((p, i) => [p, sheets[i]]));
    const backSheet = new Map(sat.map((p, i) => [p, sheets[sheets.length - 1 - i]]));

    for (const pair of matchBatch(cagi, sat, 'reversed')) {
      expect(backSheet.get(pair.satisfactionPath)).toBe(frontSheet.get(pair.cagiPath));
    }
  });

  it('sorts naturally before pairing, so page 10 follows page 9 either way', () => {
    const cagi = pages('cagi', 11);
    const sat = pages('satisfaction', 11);
    const shuffled = [...sat].sort(() => -1);
    expect(matchBatch(cagi, shuffled, 'reversed')[0].satisfactionPath).toBe(sat[10]);
    expect(matchBatch(cagi, shuffled, 'same')[0].satisfactionPath).toBe(sat[0]);
  });

  it('still refuses stacks of different length, whatever the order', () => {
    expect(() => matchBatch(pages('cagi', 3), pages('satisfaction', 2))).toThrow(/장수가 일치하지 않습니다/);
    expect(() => matchBatch(pages('cagi', 3), pages('satisfaction', 2), 'reversed')).toThrow(/장수가 일치하지 않습니다/);
  });

  it('does not mutate the arrays it was given', () => {
    const cagi = pages('cagi', 3);
    const sat = pages('satisfaction', 3);
    const satBefore = [...sat];
    matchBatch(cagi, sat, 'reversed');
    expect(sat).toEqual(satBefore);
  });
});

describe('describePairing', () => {
  it('mirrors what matchBatch will do, so the preview cannot disagree with it', () => {
    const cagi = pages('cagi', 19);
    const sat = pages('satisfaction', 19);
    for (const order of ['same', 'reversed'] as const) {
      const pairs = matchBatch(cagi, sat, order);
      const described = describePairing(19, order);
      described.forEach((row, index) => {
        expect(pairs[index].cagiPath).toContain(`cagi_page_${String(row.cagiPage).padStart(3, '0')}`);
        expect(pairs[index].satisfactionPath)
          .toContain(`satisfaction_page_${String(row.satisfactionPage).padStart(3, '0')}`);
      });
    }
  });

  it('shows the reversal at the ends, which is where a wrong setting is visible', () => {
    const rows = describePairing(19, 'reversed');
    expect(rows[0]).toEqual({ student: 1, cagiPage: 1, satisfactionPage: 19 });
    expect(rows[18]).toEqual({ student: 19, cagiPage: 19, satisfactionPage: 1 });
  });
});

describe('isStackOrder', () => {
  it('accepts only the two values the API may act on', () => {
    expect(isStackOrder('same')).toBe(true);
    expect(isStackOrder('reversed')).toBe(true);
    for (const bad of ['SAME', 'reverse', '', null, undefined, 0, 1, true, {}, ['reversed']]) {
      expect(isStackOrder(bad)).toBe(false);
    }
  });
});
