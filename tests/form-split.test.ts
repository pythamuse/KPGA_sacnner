import { describe, it, expect } from 'vitest';
import {
  MIN_DECISION_INLIERS,
  MIN_DECISION_MARGIN,
  decideFormSide,
  splitBySide,
  type FormSide,
} from '../src/lib/formSplit';

const score = (inliers: number, goodMatches = Math.max(inliers, 1)) => ({
  inliers,
  goodMatches,
  inlierRatio: goodMatches === 0 ? 0 : inliers / goodMatches,
});

describe('decideFormSide', () => {
  it('picks the template with more inliers on a clear win', () => {
    // Stage-1-shaped numbers: a front photo scores ~200 on cagi, ~25 on sat.
    const decision = decideFormSide({ cagi: score(212, 300), satisfaction: score(24, 190) });
    expect(decision.side).toBe('cagi');
    expect(decision.bestInliers).toBe(212);
    expect(decision.secondInliers).toBe(24);
    expect(decision.margin).toBeCloseTo(212 / 24, 6);
    expect(decision.reason).toBeNull();
  });

  it('picks satisfaction when that template wins', () => {
    const decision = decideFormSide({ cagi: score(31, 200), satisfaction: score(188, 260) });
    expect(decision.side).toBe('satisfaction');
    expect(decision.bestInliers).toBe(188);
  });

  it('refuses when the margin is below the floor, however strong the winner', () => {
    // 180 vs 120: both templates matched well, so which sheet this is is not
    // established -- exactly the case the user must settle.
    const decision = decideFormSide({ cagi: score(180, 400), satisfaction: score(120, 400) });
    expect(decision.margin).toBeLessThan(MIN_DECISION_MARGIN);
    expect(decision.side).toBeNull();
    expect(decision.reason).toBe('weak-margin');
  });

  it('accepts a margin exactly at the floor', () => {
    const decision = decideFormSide({ cagi: score(120, 300), satisfaction: score(60, 300) });
    expect(decision.margin).toBe(MIN_DECISION_MARGIN);
    expect(decision.side).toBe('cagi');
  });

  it('refuses when the best inlier count is below the floor, however wide the margin', () => {
    // 40 vs 2 is a 20x margin, but 40 inliers is not a registration.
    const decision = decideFormSide({ cagi: score(40, 300), satisfaction: score(2, 300) });
    expect(decision.margin).toBeGreaterThan(MIN_DECISION_MARGIN);
    expect(decision.bestInliers).toBeLessThan(MIN_DECISION_INLIERS);
    expect(decision.side).toBeNull();
    expect(decision.reason).toBe('weak-best');
  });

  it('accepts a best inlier count exactly at the floor', () => {
    const decision = decideFormSide({ cagi: score(MIN_DECISION_INLIERS, 200), satisfaction: score(5, 200) });
    expect(decision.side).toBe('cagi');
    expect(decision.reason).toBeNull();
  });

  it('handles a second-best of 0 without dividing by zero', () => {
    const decision = decideFormSide({ cagi: score(0, 180), satisfaction: score(140, 220) });
    expect(Number.isFinite(decision.margin)).toBe(true);
    expect(decision.margin).toBe(140);
    expect(decision.side).toBe('satisfaction');
  });

  it('refuses two zero scores (the worker could not read the photo)', () => {
    const decision = decideFormSide({ cagi: score(0, 0), satisfaction: score(0, 0) });
    expect(decision.side).toBeNull();
    expect(decision.reason).toBe('weak-best');
    expect(decision.margin).toBe(0);
  });

  it('refuses a tie rather than breaking it arbitrarily', () => {
    const decision = decideFormSide({ cagi: score(150, 300), satisfaction: score(150, 300) });
    expect(decision.side).toBeNull();
    expect(decision.reason).toBe('weak-margin');
  });
});

// --- splitBySide -------------------------------------------------------

type Row = { id: string; side: FormSide | null };
const row = (id: string, side: FormSide | null): Row => ({ id, side });
const idsOf = (rows: Row[]) => rows.map((r) => r.id);

describe('splitBySide', () => {
  it('preserves displayed order within each side', () => {
    // Interleaved on purpose: order within a side must come from the list
    // position, not from adjacency in the combined list.
    const result = splitBySide([
      row('f1', 'cagi'),
      row('b1', 'satisfaction'),
      row('f2', 'cagi'),
      row('b2', 'satisfaction'),
      row('f3', 'cagi'),
      row('b3', 'satisfaction'),
    ]);
    expect(idsOf(result.cagi)).toEqual(['f1', 'f2', 'f3']);
    expect(idsOf(result.satisfaction)).toEqual(['b1', 'b2', 'b3']);
    expect(result.ready).toBe(true);
  });

  it('handles the real capture shape: all fronts, then all backs', () => {
    const result = splitBySide([
      row('f1', 'cagi'), row('f2', 'cagi'),
      row('b1', 'satisfaction'), row('b2', 'satisfaction'),
    ]);
    expect(idsOf(result.cagi)).toEqual(['f1', 'f2']);
    expect(idsOf(result.satisfaction)).toEqual(['b1', 'b2']);
    expect(result.ready).toBe(true);
  });

  it('blocks while any row is undecided, even when the decided rows balance', () => {
    const result = splitBySide([
      row('f1', 'cagi'),
      row('b1', 'satisfaction'),
      row('x', null),
    ]);
    expect(result.undecidedCount).toBe(1);
    expect(result.balanced).toBe(true);
    expect(result.ready).toBe(false);
  });

  it('reports a count mismatch and blocks', () => {
    const result = splitBySide([
      row('f1', 'cagi'), row('f2', 'cagi'), row('f3', 'cagi'),
      row('b1', 'satisfaction'), row('b2', 'satisfaction'),
    ]);
    expect(result.cagi).toHaveLength(3);
    expect(result.satisfaction).toHaveLength(2);
    expect(result.undecidedCount).toBe(0);
    expect(result.balanced).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('blocks an all-one-side pick (0 vs n is not a balanced pair)', () => {
    const result = splitBySide([row('f1', 'cagi'), row('f2', 'cagi')]);
    expect(result.satisfaction).toHaveLength(0);
    expect(result.balanced).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('blocks an empty list', () => {
    const result = splitBySide<Row>([]);
    expect(result.ready).toBe(false);
    expect(result.undecidedCount).toBe(0);
  });
});
