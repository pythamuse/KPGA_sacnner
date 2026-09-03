import { describe, expect, it } from 'vitest';
import {
  bulkConfirmableFields,
  cancelRefusedFields,
  contestedUnconfirmedFields,
  unconfirmedMachineFields,
} from '../src/lib/review/settlement';
import { describeEvidence } from '../src/lib/review/evidence';

/**
 * The cancelled-mark veto withholds a value instead of filling one, so the cell
 * it refuses is EMPTY. An empty cell is outside the save gate's three
 * selectors by design -- it must never become bulk-confirmable -- and that is
 * exactly why the reason never reached the reviewer: nothing named it, and
 * `describeEvidence` printed only the contested ranking.
 *
 * Judged on the real set in Task/CANCEL_VETO_2026-09-03.md.
 */

const draft = {
  basic: { age: 14 },
  cagi: { q01: 0 },
  satisfaction: { q07: undefined, q08: 4 },
  confidence: { 'basic.age': 'high', 'cagi.q01': 'high', 'satisfaction.q08': 'high' },
  source: {
    recognitionValueSource: {
      'basic.age': 'auto',
      'cagi.q01': 'auto',
      'satisfaction.q08': 'auto',
    },
    recognitionContested: { 'satisfaction.q07': true, 'satisfaction.q08': true },
    recognitionEvidence: {
      'satisfaction.q07': { refused: ['cancel-crossing'] },
      'satisfaction.q08': { refused: [] },
    },
  },
} as unknown as Parameters<typeof cancelRefusedFields>[0];

describe('a cell the cancelled-mark veto refused', () => {
  it('is named by cancelRefusedFields', () => {
    expect(cancelRefusedFields(draft)).toEqual(['satisfaction.q07']);
  });

  it('stays out of the three save-gate selectors, because it has no value', () => {
    expect(unconfirmedMachineFields(draft)).not.toContain('satisfaction.q07');
    expect(contestedUnconfirmedFields(draft)).not.toContain('satisfaction.q07');
    expect(bulkConfirmableFields(draft)).not.toContain('satisfaction.q07');
  });

  it('leaves the filled contested cell exactly where it was', () => {
    expect(unconfirmedMachineFields(draft)).toContain('satisfaction.q08');
    expect(contestedUnconfirmedFields(draft)).toContain('satisfaction.q08');
    expect(bulkConfirmableFields(draft)).not.toContain('satisfaction.q08');
  });

  it('does not mistake a refusal for some other cause', () => {
    const other = {
      ...draft,
      source: {
        ...draft.source,
        recognitionEvidence: { 'satisfaction.q07': { refused: ['relative-contrast'] } },
      },
    } as typeof draft;
    expect(cancelRefusedFields(other)).toEqual([]);
  });
});

describe('the sentence a reviewer reads on that cell', () => {
  it('carries the refusal reason beside the contested ranking', () => {
    const sentence = describeEvidence(
      {
        outcome: 'contested',
        contested: true,
        winner: { index: 4, score: 0.046 },
        runnerUp: { index: 3, score: 0.036 },
        refused: ['cancel-crossing'],
      } as never,
      ['0', '1', '2', '3', '4'],
    );
    expect(sentence).toContain('경합');
    expect(sentence).toContain('취소 표시로 보이는 교차 획');
  });

  it('says nothing extra when a contested row was not refused', () => {
    const sentence = describeEvidence(
      {
        outcome: 'contested',
        contested: true,
        winner: { index: 4, score: 0.065 },
        runnerUp: { index: 0, score: 0.033 },
      } as never,
      ['0', '1', '2', '3', '4'],
    );
    expect(sentence).toContain('경합');
    expect(sentence).not.toContain('보류');
  });
});
