/**
 * Deciding which form a loose photo is, and splitting one combined pick into
 * the two per-kind stacks (Task/PHOTO_BATCH_ORDER_2026-09-09.md §3 item E,
 * Task/FEATURE_PLAN_2026-09-09.md §3 stage 2).
 *
 * Pure on purpose: no React, no OpenCV, no File I/O. The scores come from the
 * perspective-correction worker (`classifyFormInWorker`), which runs the
 * shipped `alignToTemplate` against BOTH committed ORB templates on the same
 * detection frame the correction path builds. Everything below is arithmetic
 * on those two numbers, so it is unit-testable and the e2e script can call the
 * exact function the UI calls.
 */

export type FormSide = 'cagi' | 'satisfaction';

/** One template's alignment result, as the worker reports it. */
export interface FormAlignScore {
  inliers: number;
  goodMatches: number;
  inlierRatio: number;
}

export interface FormAlignScores {
  cagi: FormAlignScore;
  satisfaction: FormAlignScore;
}

export interface FormDecision {
  /** null = undecided; the user must pick the side themselves. */
  side: FormSide | null;
  /** Inlier count of the winning template (0 when neither aligned). */
  bestInliers: number;
  /** Inlier count of the losing template. */
  secondInliers: number;
  /** bestInliers / max(secondInliers, 1) -- never divides by zero. */
  margin: number;
  /** Why the decision was refused; null when a side was decided. */
  reason: 'weak-margin' | 'weak-best' | null;
}

/**
 * SAFETY FLOORS, NOT TUNED VALUES.
 *
 * Stage 1 aligned all 114 raw photos of sets 1-3 against both templates and
 * got 114/114 correct, with min margin 4.11 (p05 5.08, median 8.83) and min
 * best-inlier count 95. These two floors sit far below every one of those
 * measurements, so on the measured population they refuse nothing -- they
 * exist to catch a photo unlike anything in that sample (a blurred frame, a
 * different form, a picture of the desk) and hand it to the user instead of
 * guessing. They were NOT swept for an optimum against the sample, and moving
 * them toward the measured minimum would be exactly that.
 */
export const MIN_DECISION_MARGIN = 2;
export const MIN_DECISION_INLIERS = 50;

/**
 * Which form this photo is, from the two alignment scores. More inliers wins;
 * a thin win or a weak winner is refused rather than guessed.
 */
export function decideFormSide(scores: FormAlignScores): FormDecision {
  const cagiInliers = Number.isFinite(scores.cagi?.inliers) ? scores.cagi.inliers : 0;
  const satInliers = Number.isFinite(scores.satisfaction?.inliers) ? scores.satisfaction.inliers : 0;

  const bestInliers = Math.max(cagiInliers, satInliers);
  const secondInliers = Math.min(cagiInliers, satInliers);
  // max(second, 1): a losing template with 0 inliers would otherwise make this
  // Infinity/NaN. Treating "0" as "1" keeps the ratio finite and ordered, and
  // the winner still has to clear MIN_DECISION_INLIERS on its own.
  const margin = bestInliers / Math.max(secondInliers, 1);

  if (bestInliers < MIN_DECISION_INLIERS) {
    return { side: null, bestInliers, secondInliers, margin, reason: 'weak-best' };
  }
  if (margin < MIN_DECISION_MARGIN) {
    return { side: null, bestInliers, secondInliers, margin, reason: 'weak-margin' };
  }

  return {
    side: cagiInliers > satInliers ? 'cagi' : 'satisfaction',
    bestInliers,
    secondInliers,
    margin,
    reason: null,
  };
}

/** The minimum a row needs for the split; the UI row carries much more. */
export interface SidedItem {
  side: FormSide | null;
}

export interface FormSplitResult<T extends SidedItem> {
  /** Rows whose side is 'cagi' (front), in their displayed order. */
  cagi: T[];
  /** Rows whose side is 'satisfaction' (back), in their displayed order. */
  satisfaction: T[];
  /** How many rows still have no side. */
  undecidedCount: number;
  /** True when the two stacks are non-empty and of equal length. */
  balanced: boolean;
  /** Can this be registered? Requires no undecided rows and a balanced split. */
  ready: boolean;
}

/**
 * Splits the combined, already-ordered list into the front and back stacks.
 *
 * Order within each stack is the DISPLAYED order, not adjacency: the photos in
 * a set were shot front-pass-then-back-pass, so after a capture-time sort all
 * fronts precede all backs. Student n is front[n] paired with back[n], which
 * is what `runBatchFromRawFiles` + the existing pairing strip already assume
 * for two separately-picked stacks.
 */
export function splitBySide<T extends SidedItem>(rows: T[]): FormSplitResult<T> {
  const cagi: T[] = [];
  const satisfaction: T[] = [];
  let undecidedCount = 0;

  for (const row of rows) {
    if (row.side === 'cagi') cagi.push(row);
    else if (row.side === 'satisfaction') satisfaction.push(row);
    else undecidedCount += 1;
  }

  const balanced = cagi.length > 0 && cagi.length === satisfaction.length;
  return {
    cagi,
    satisfaction,
    undecidedCount,
    balanced,
    ready: undecidedCount === 0 && balanced,
  };
}
