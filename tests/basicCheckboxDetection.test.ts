import { describe, expect, it, afterEach } from 'vitest';
import type { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import type { BasicCheckboxCandidate } from '../src/lib/recognition/basicCheckboxDetection';
import { __probe } from '../src/lib/recognition/basicCheckboxDetection';

/**
 * Cycle 2 (BASIC_BOX_MATCH_V2): synthetic tests for Sections A-C, exercised
 * at the geometry level via __probe.matchReferencesToCandidates -- the same
 * dispatch matchBasicCheckboxes uses -- so no rasterised page or student
 * file is needed. See Task/CYCLE2_BASIC_PLACEMENT_AGENT_REPORT_2026-09-05.md
 * and cycle2-order.md.
 *
 * Scenario (order Section E): 12 references in three choice groups (2, 4, 6
 * -- gender, school type, grade). One reference per group has no real box
 * candidate at all (its printed frame was swallowed by ink); every reference
 * -- present or missing -- has a low-frameScore "letter" candidate to its
 * left (5-29 page-pixels of a 1000px-wide content box), standing in for the
 * field-name glyph that sits beside every checkbox on the real form. The
 * offsets are deliberately non-uniform, so there is no single translation
 * that aligns all twelve simultaneously at (or near) zero residual --
 * matching how differently-worded labels actually sit on the page.
 */

const GROUP_SIZES = [2, 4, 6];
const CONTENT_WIDTH = 1000; // page pixels the normalized offsets below are expressed against
const BOX_FRAME_SCORE = 0.6; // a real printed box, per the order's fact #2 (0.54-0.63)
const LETTER_FRAME_SCORE = 0.46; // a label glyph's last character (0.46-0.48)

// One missing reference per group: gender[1], schoolType[1], grade[2] (flat
// indices 1, 3, 8 into the 12-long reference list).
const MISSING_FLAT_INDICES = new Set([1, 3, 8]);

// Non-uniform letter offsets in page pixels (left of the reference). The
// nine present references get a wide, arbitrary spread (5-21px) so no single
// translation aligns them all closely -- real label glyphs of different
// widths do not sit at one common offset either. The three missing
// references get an offset (27-29px) larger than MATCH_TOLERANCE +
// SMALL_TRANSLATION_LIMIT (18+9=27px), so their letter is never a reachable
// candidate at any small-shift seed: at t=0 (and everywhere else `assignCand
// idatesWithMissing` tries within the small bucket) "missing" is their only
// option, not merely their cheapest one. See the report for the arithmetic
// behind both choices.
const LETTER_OFFSET_PX = [5, 28, 9, 29, 13, 17, 21, 6, 27, 15, 19, 11];

function px(value: number): number {
  return value / CONTENT_WIDTH;
}

function buildGroups(): ChoiceGroup[] {
  let value = 0;
  return GROUP_SIZES.map((size, groupIndex) => ({
    field: `basic.group${groupIndex}`,
    candidates: Array.from({ length: size }, () => ({ value: value++, rect: { x: 0, y: 0, width: 0.02, height: 0.02 } })),
  }));
}

function buildReferences(): Array<{ x: number; y: number }> {
  const references: Array<{ x: number; y: number }> = [];
  GROUP_SIZES.forEach((size, groupIndex) => {
    for (let i = 0; i < size; i += 1) {
      // 0.10 spacing in x, far larger than MAX_TRANSLATION (0.03) or
      // MATCH_TOLERANCE (0.018), so no reference's tolerance window can ever
      // reach a neighbouring reference's candidates.
      references.push({ x: 0.1 + i * 0.1, y: 0.1 + groupIndex * 0.1 });
    }
  });
  return references;
}

function dummyRect(centerX: number, centerY: number) {
  // Only used by constrainMatchesToLayout, which these tests do not reach;
  // present so BasicCheckboxCandidate stays structurally valid.
  return { left: centerX - 1, top: centerY - 1, right: centerX + 1, bottom: centerY + 1 };
}

function buildCandidates(references: Array<{ x: number; y: number }>): BasicCheckboxCandidate[] {
  const candidates: BasicCheckboxCandidate[] = [];
  references.forEach((reference, index) => {
    if (!MISSING_FLAT_INDICES.has(index)) {
      candidates.push({
        rect: dummyRect(reference.x * CONTENT_WIDTH, reference.y * CONTENT_WIDTH),
        center: { x: reference.x, y: reference.y },
        fillRatio: 0.4,
        frameScore: BOX_FRAME_SCORE,
      });
    }
    const letterX = reference.x - px(LETTER_OFFSET_PX[index]);
    candidates.push({
      rect: dummyRect(letterX * CONTENT_WIDTH, reference.y * CONTENT_WIDTH),
      center: { x: letterX, y: reference.y },
      fillRatio: 0.4,
      frameScore: LETTER_FRAME_SCORE,
    });
  });
  return candidates;
}

const ORIGINAL_FLAG = process.env.BASIC_BOX_MATCH_V2;

describe('matchReferencesToCandidates (BASIC_BOX_MATCH_V2)', () => {
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.BASIC_BOX_MATCH_V2;
    } else {
      process.env.BASIC_BOX_MATCH_V2 = ORIGINAL_FLAG;
    }
  });

  it('V2 on (default): picks translation~=0, leaves the three ink-swallowed references missing, and never assigns a letter candidate', () => {
    delete process.env.BASIC_BOX_MATCH_V2;
    const groups = buildGroups();
    const references = buildReferences();
    const candidates = buildCandidates(references);

    const match = __probe.matchReferencesToCandidates(references, candidates, groups);
    expect(match).toBeDefined();
    if (!match) return;

    // The small-shift bucket's own best (t=(0,0), all nine present
    // references at their real box) is never beaten here: none of the three
    // missing references' letters are reachable within SMALL_TRANSLATION_
    // LIMIT (see the offset comment above), so no large-shift seed can ever
    // assign all twelve and clear the 20% margin against it.
    expect(match.translation).toEqual({ x: 0, y: 0 });
    expect(match.missingCount).toBe(3);
    expect(match.smallCandidateFound).toBe(true);
    expect(match.usedLargeShift).toBe(false);
    expect(match.frameMean).toBeCloseTo(BOX_FRAME_SCORE, 6);

    match.matches.forEach((entry, index) => {
      if (MISSING_FLAT_INDICES.has(index)) {
        expect(entry.missing).toBe(true);
        expect(entry.candidateIndex).toBe(-1);
      } else {
        expect(entry.missing).toBeFalsy();
        expect(candidates[entry.candidateIndex].frameScore).toBe(BOX_FRAME_SCORE);
      }
    });
  });

  it('V2 off (BASIC_BOX_MATCH_V2=0): today\'s exact-count matcher shifts the whole layout onto the letter column', () => {
    process.env.BASIC_BOX_MATCH_V2 = '0';
    const groups = buildGroups();
    const references = buildReferences();
    const candidates = buildCandidates(references);

    const match = __probe.matchReferencesToCandidates(references, candidates, groups);
    expect(match).toBeDefined();
    if (!match) return;

    // No missing-tolerance in this path: TranslationMatch never carries it.
    expect(match.missingCount).toBeUndefined();
    expect(match.matches).toHaveLength(references.length);
    // A real, large shift -- not the near-zero translation the V2 path
    // settles on above.
    expect(Math.abs(match.translation.x)).toBeGreaterThan(0.009);
    // Every one of the twelve references was pulled onto its letter
    // candidate -- including the nine that have a perfectly-placed real box
    // available -- because a full 12-of-12 assignment is required and the
    // letter column, taken as a whole, is internally the more consistent
    // (lower total distance) pattern once nine boxes would otherwise sit at
    // a translation the other three cannot reach at all.
    match.matches.forEach((entry) => {
      expect(candidates[entry.candidateIndex].frameScore).toBe(LETTER_FRAME_SCORE);
    });
  });
});

describe('matchReferencesToCandidates photoProvenance scoping (2026-09-05 follow-up)', () => {
  const ORIGINAL_PHOTOS_FLAG = process.env.BASIC_BOX_MATCH_V2_PHOTOS;

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.BASIC_BOX_MATCH_V2;
    } else {
      process.env.BASIC_BOX_MATCH_V2 = ORIGINAL_FLAG;
    }
    if (ORIGINAL_PHOTOS_FLAG === undefined) {
      delete process.env.BASIC_BOX_MATCH_V2_PHOTOS;
    } else {
      process.env.BASIC_BOX_MATCH_V2_PHOTOS = ORIGINAL_PHOTOS_FLAG;
    }
  });

  it('photoProvenance=true is byte-identical to the flag-off (BASIC_BOX_MATCH_V2=0) result, even with V2 on', () => {
    delete process.env.BASIC_BOX_MATCH_V2;
    delete process.env.BASIC_BOX_MATCH_V2_PHOTOS;
    const groups = buildGroups();
    const references = buildReferences();
    const candidates = buildCandidates(references);

    const photoMatch = __probe.matchReferencesToCandidates(references, candidates, groups, true);

    process.env.BASIC_BOX_MATCH_V2 = '0';
    const flagOffMatch = __probe.matchReferencesToCandidates(references, candidates, groups, false);

    expect(photoMatch).toBeDefined();
    expect(photoMatch).toEqual(flagOffMatch);
  });

  it('BASIC_BOX_MATCH_V2_PHOTOS=1 re-enables the V2 assignment for photos', () => {
    delete process.env.BASIC_BOX_MATCH_V2;
    process.env.BASIC_BOX_MATCH_V2_PHOTOS = '1';
    const groups = buildGroups();
    const references = buildReferences();
    const candidates = buildCandidates(references);

    const photoMatch = __probe.matchReferencesToCandidates(references, candidates, groups, true);
    const nonPhotoMatch = __probe.matchReferencesToCandidates(references, candidates, groups, false);

    expect(photoMatch).toBeDefined();
    expect(photoMatch).toEqual(nonPhotoMatch);
    expect(photoMatch?.missingCount).toBe(3);
    expect(photoMatch?.translation).toEqual({ x: 0, y: 0 });
  });

  it('isBasicBoxMatchV2EnabledFor: photos need the override even when BASIC_BOX_MATCH_V2 is on; non-photos never need it', () => {
    delete process.env.BASIC_BOX_MATCH_V2;
    delete process.env.BASIC_BOX_MATCH_V2_PHOTOS;
    expect(__probe.isBasicBoxMatchV2EnabledFor(false)).toBe(true);
    expect(__probe.isBasicBoxMatchV2EnabledFor(true)).toBe(false);

    process.env.BASIC_BOX_MATCH_V2_PHOTOS = '1';
    expect(__probe.isBasicBoxMatchV2EnabledFor(true)).toBe(true);

    process.env.BASIC_BOX_MATCH_V2 = '0';
    expect(__probe.isBasicBoxMatchV2EnabledFor(true)).toBe(false);
    expect(__probe.isBasicBoxMatchV2EnabledFor(false)).toBe(false);
  });
});

/**
 * Cycle 4, Section A (BASIC_BOX_FRAME_PREFER): synthetic test built directly
 * on __probe.findTranslationMatchV2, the same seed search
 * matchReferencesToCandidates dispatches to under BASIC_BOX_MATCH_V2. See
 * cycle4-order.md and Task/CYCLE4_BASIC_SIGNALS_AGENT_REPORT_2026-09-05.md.
 *
 * One choice group, two references spaced 0.2 apart (far past MAX_TRANSLATION
 * 0.03, so neither reference's tolerance window can ever reach the other's
 * candidates). Each reference has two candidates:
 *
 *   - a "box" 0.001 (page-normalized) off its own reference, frameScore 0.6 --
 *     a real printed box, per the cycle 2 order's fact #2 range (0.54-0.63).
 *     The two offsets have opposite sign so no single seed zeroes both at
 *     once; seed (0,0) -- always tried first -- is what wins the small
 *     bucket, at cost 0.001*1.4 = 0.0014 per reference (frameWeight 1: weighted
 *     = distance*(2-frameScore)).
 *   - a "letter" 0.02 off its own reference (same sign for both references),
 *     frameScore 0.45 -- a label glyph's last character, per the same order's
 *     range (0.46-0.48). 0.02 is a valid seed (<= MAX_TRANSLATION) and lands
 *     in the *large*-shift bucket (> SMALL_TRANSLATION_LIMIT, half of
 *     MATCH_TOLERANCE 0.018 = 0.009). The shared offset means one seed,
 *     (-0.02, 0), zeroes both letters' distance at once: weightedTotal 0,
 *     comfortably more than 20% cheaper than the small-shift best (0.0028)
 *     -- BASIC_BOX_LARGE_SHIFT_MARGIN's default cost-margin rule alone would
 *     adopt it.
 *
 * frameMean(small) = 0.6, frameMean(large) = 0.45: a 0.15 gap, past
 * BASIC_BOX_FRAME_PREFER_MARGIN's default 0.06. So the frame-prefer rule
 * (on by default) overrides the cost-margin winner and keeps the small
 * shift; BASIC_BOX_FRAME_PREFER=0 restores cycle 2's cost-only selection,
 * which lands on the letters.
 */
describe('findTranslationMatchV2 frame-prefer override (BASIC_BOX_FRAME_PREFER)', () => {
  const ORIGINAL_PREFER = process.env.BASIC_BOX_FRAME_PREFER;
  const ORIGINAL_MARGIN = process.env.BASIC_BOX_FRAME_PREFER_MARGIN;
  const TOLERANCE = 0.018; // mirrors basicCheckboxDetection.ts's private MATCH_TOLERANCE

  afterEach(() => {
    if (ORIGINAL_PREFER === undefined) {
      delete process.env.BASIC_BOX_FRAME_PREFER;
    } else {
      process.env.BASIC_BOX_FRAME_PREFER = ORIGINAL_PREFER;
    }
    if (ORIGINAL_MARGIN === undefined) {
      delete process.env.BASIC_BOX_FRAME_PREFER_MARGIN;
    } else {
      process.env.BASIC_BOX_FRAME_PREFER_MARGIN = ORIGINAL_MARGIN;
    }
  });

  const BOX_FRAME_SCORE = 0.6;
  const LETTER_FRAME_SCORE = 0.45;
  const groups: ChoiceGroup[] = [{
    field: 'basic.group0',
    candidates: [
      { value: 0, rect: { x: 0, y: 0, width: 0.02, height: 0.02 } },
      { value: 1, rect: { x: 0, y: 0, width: 0.02, height: 0.02 } },
    ],
  }];
  const references = [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.1 },
  ];

  function dummyRect(centerX: number, centerY: number) {
    return { left: centerX - 1, top: centerY - 1, right: centerX + 1, bottom: centerY + 1 };
  }

  function buildCandidates(): BasicCheckboxCandidate[] {
    return [
      // Boxes: +0.001 off reference 0, -0.001 off reference 1 (opposite sign).
      {
        rect: dummyRect(references[0].x * 1000, references[0].y * 1000),
        center: { x: references[0].x + 0.001, y: references[0].y },
        fillRatio: 0.4,
        frameScore: BOX_FRAME_SCORE,
      },
      {
        rect: dummyRect(references[1].x * 1000, references[1].y * 1000),
        center: { x: references[1].x - 0.001, y: references[1].y },
        fillRatio: 0.4,
        frameScore: BOX_FRAME_SCORE,
      },
      // Letters: -0.02 off both references (shared sign/magnitude).
      {
        rect: dummyRect(references[0].x * 1000, references[0].y * 1000),
        center: { x: references[0].x - 0.02, y: references[0].y },
        fillRatio: 0.4,
        frameScore: LETTER_FRAME_SCORE,
      },
      {
        rect: dummyRect(references[1].x * 1000, references[1].y * 1000),
        center: { x: references[1].x - 0.02, y: references[1].y },
        fillRatio: 0.4,
        frameScore: LETTER_FRAME_SCORE,
      },
    ];
  }

  it('sets up the premise: the large shift clears the 20% cost margin on its own', () => {
    delete process.env.BASIC_BOX_FRAME_PREFER;
    process.env.BASIC_BOX_FRAME_PREFER = '0'; // isolate the pre-existing cost-margin rule
    const candidates = buildCandidates();
    const groupOfReference = __probe.referenceGroupIndices(groups);
    const match = __probe.findTranslationMatchV2(references, candidates, TOLERANCE, groupOfReference, groups.length);
    expect(match).toBeDefined();
    if (!match) return;
    expect(match.usedLargeShift).toBe(true);
    expect(match.translation.x).toBeCloseTo(-0.02, 6);
    expect(match.translation.y).toBeCloseTo(0, 6);
    expect(match.frameMean).toBeCloseTo(LETTER_FRAME_SCORE, 6);
    expect(match.framePrefer).toBeUndefined();
  });

  it('BASIC_BOX_FRAME_PREFER on (default): keeps the small shift despite the cost margin', () => {
    delete process.env.BASIC_BOX_FRAME_PREFER;
    const candidates = buildCandidates();
    const groupOfReference = __probe.referenceGroupIndices(groups);
    const match = __probe.findTranslationMatchV2(references, candidates, TOLERANCE, groupOfReference, groups.length);
    expect(match).toBeDefined();
    if (!match) return;
    expect(match.framePrefer).toBe('yes');
    expect(match.usedLargeShift).toBe(false);
    expect(match.translation).toEqual({ x: 0, y: 0 });
    expect(match.frameMean).toBeCloseTo(BOX_FRAME_SCORE, 6);
    match.matches.forEach((entry) => {
      expect(candidates[entry.candidateIndex].frameScore).toBe(BOX_FRAME_SCORE);
    });
  });

  it('BASIC_BOX_FRAME_PREFER=0: today\'s cost-only selection, lands on the letters', () => {
    process.env.BASIC_BOX_FRAME_PREFER = '0';
    const candidates = buildCandidates();
    const groupOfReference = __probe.referenceGroupIndices(groups);
    const match = __probe.findTranslationMatchV2(references, candidates, TOLERANCE, groupOfReference, groups.length);
    expect(match).toBeDefined();
    if (!match) return;
    expect(match.framePrefer).toBeUndefined();
    expect(match.usedLargeShift).toBe(true);
    expect(match.translation.x).toBeCloseTo(-0.02, 6);
    expect(match.translation.y).toBeCloseTo(0, 6);
    match.matches.forEach((entry) => {
      expect(candidates[entry.candidateIndex].frameScore).toBe(LETTER_FRAME_SCORE);
    });
  });

  it('BASIC_BOX_FRAME_PREFER_MARGIN raised past the 0.15 gap: no longer triggers', () => {
    delete process.env.BASIC_BOX_FRAME_PREFER;
    process.env.BASIC_BOX_FRAME_PREFER_MARGIN = '0.2';
    const candidates = buildCandidates();
    const groupOfReference = __probe.referenceGroupIndices(groups);
    const match = __probe.findTranslationMatchV2(references, candidates, TOLERANCE, groupOfReference, groups.length);
    expect(match).toBeDefined();
    if (!match) return;
    expect(match.framePrefer).toBe('no');
    expect(match.usedLargeShift).toBe(true);
    expect(match.translation.x).toBeCloseTo(-0.02, 6);
    expect(match.translation.y).toBeCloseTo(0, 6);
  });
});
