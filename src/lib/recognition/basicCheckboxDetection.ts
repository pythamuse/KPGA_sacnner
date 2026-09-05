import {
  getRegistrationBounds,
  type ImageAnalysisData,
  type PixelRect,
} from './markDensity';
import type { ChoiceGroup } from './roiTemplates';

export interface BasicCheckboxCandidate {
  rect: PixelRect;
  /** Center normalized to the image's content bounds. */
  center: { x: number; y: number };
  fillRatio: number;
  frameScore: number;
}

export interface BasicCheckboxBaselineDetection {
  candidateRects: Record<string, PixelRect[]>;
  candidateCount: number;
  matchedCount: number;
  maxResidual: number;
}

export interface BasicCheckboxGridDetection {
  overrides: Record<string, PixelRect[]>;
  candidateCount: number;
  matchedCount: number;
  maxResidual: number;
  translation: { x: number; y: number };
  /**
   * How far each option box had to be moved to agree with the layout the rest
   * of the page fits, in page pixels, zero where the match was believed as
   * found. Reported so the correction can be read back on real scans.
   */
  corrections: Record<string, number[]>;
  diagnostic: string;
}

interface NormalizedPoint {
  x: number;
  y: number;
}

interface Match {
  candidateIndex: number;
  distance: number;
  /** Section A (BASIC_BOX_MATCH_V2): true when this reference had no
   * candidate at all and was assigned the missing-reference cost instead.
   * `candidateIndex` is -1 in that case; constrainMatchesToLayout places it
   * at the layout-predicted position, the same as it already does for a
   * candidate that disagrees with the other eleven. */
  missing?: boolean;
}

interface TranslationMatch {
  translation: NormalizedPoint;
  matches: Match[];
  totalDistance: number;
  maxDistance: number;
  /** Set only by the V2 path (BASIC_BOX_MATCH_V2): how many references were
   * left missing instead of forced onto a distant candidate (Section A). */
  missingCount?: number;
  /** V2 only: mean frameScore among the matches that were not missing. */
  frameMean?: number;
  /** V2 only: whether any small-translation seed produced a full assignment
   * at all (Section C), regardless of whether it was the one adopted. */
  smallCandidateFound?: boolean;
  /** V2 only: true when a larger-shift assignment cleared the margin over the
   * best small-shift one and was adopted instead. */
  usedLargeShift?: boolean;
}

const DARK_THRESHOLD = 180;
const BASIC_REGION = {
  left: 0.005,
  right: 0.995,
  top: 0.12,
  bottom: 0.24,
};
const MIN_COMPONENT_SIZE = 12;
const MAX_COMPONENT_SIZE = 34;
const MIN_ASPECT_RATIO = 0.7;
const MAX_ASPECT_RATIO = 1.45;
const MIN_FILL_RATIO = 0.15;
const MAX_FILL_RATIO = 0.85;
const MATCH_TOLERANCE = 0.018;
const MAX_TRANSLATION = 0.03;
const MIN_BASELINE_FRAME_SCORE = 0.65;
const ROW_CLUSTER_TOLERANCE = 0.006;

// BASIC_BOX_MATCH_V2 (default on since 2026-09-05, cycle 2 --
// Task/CYCLE2_BASIC_PLACEMENT_AGENT_REPORT_2026-09-05.md; same "!== '0'"
// convention as GRID_BAND_V2 in tableGridDetection.ts). Off restores the
// exact pre-cycle-2 behaviour byte for byte: every one of the twelve
// reference boxes must be matched to *some* candidate, which is what let a
// student's own ink (swallowing the printed frame) push the assignment onto
// the label glyph beside the box instead -- see the order's "확정된 사실" #2.
function isBasicBoxMatchV2Enabled(): boolean {
  return process.env.BASIC_BOX_MATCH_V2 !== '0';
}

/**
 * 2026-09-05 follow-up: cycle 2's missing-tolerant assignment measured one
 * new WRONG value on the photo judging sample (photo set 2 p4 basic.
 * schoolType read the horizontal neighbour box, 학교외기관 instead of the
 * keyed 중학교) and lost one correct cell on photo set 3. Photos are a
 * sample where WRONG must stay 0, so the V2 assignment is scoped out for
 * photo-provenance images regardless of BASIC_BOX_MATCH_V2, unless
 * BASIC_BOX_MATCH_V2_PHOTOS is exactly '1' -- a measurement override for
 * further work on that regression, default off. A non-photo call is
 * unaffected: only BASIC_BOX_MATCH_V2 governs it, exactly as before.
 */
function isBasicBoxMatchV2EnabledFor(photoProvenance: boolean): boolean {
  if (!isBasicBoxMatchV2Enabled()) return false;
  if (!photoProvenance) return true;
  return process.env.BASIC_BOX_MATCH_V2_PHOTOS === '1';
}

/** Section A: at most one box per choice group (gender, school type, grade)
 * is allowed to go unmatched -- a student marks one option per group, so a
 * second missing reference in the same group is a different failure mode. */
const MAX_MISSING_PER_GROUP = 1;
/** Section A: at most three of the twelve references may go missing in total. */
const MAX_MISSING_TOTAL = 3;
/** Section C: seeds at or under this |translation| are preferred outright
 * over a larger one unless the larger one clears getLargeShiftMargin(). Half
 * of MATCH_TOLERANCE, mirroring tests/_probe-basic-boxes.test.ts's own copy
 * of this constant. */
const SMALL_TRANSLATION_LIMIT = MATCH_TOLERANCE / 2;

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Section B: how strongly a low frame score (a component that reads like a
 * letter's corner, not the four sides of a printed box) inflates a
 * candidate's distance cost. BASIC_BOX_FRAME_WEIGHT overrides it for sweeps;
 * unset or invalid falls back to 1.0. */
function getFrameWeight(): number {
  return readNonNegativeNumberEnv('BASIC_BOX_FRAME_WEIGHT', 1);
}

/** Section C: how much cheaper (as a fraction of the small-shift best) a
 * larger-shift assignment must be, by weighted cost, before it is allowed to
 * win. BASIC_BOX_LARGE_SHIFT_MARGIN overrides it; unset or invalid falls back
 * to 0.2. */
function getLargeShiftMargin(): number {
  return readNonNegativeNumberEnv('BASIC_BOX_LARGE_SHIFT_MARGIN', 0.2);
}

/**
 * Detects the checkbox-like components in the unmarked form. The components
 * are ordered against the form's generic choice-group geometry only so the
 * later scorer can associate a detected box with a value; the geometry itself
 * comes from pixels, not from a template rectangle.
 */
export function detectBlankBasicCheckboxes(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
): BasicCheckboxBaselineDetection | undefined {
  const candidates = detectBasicCheckboxCandidates(image)
    .filter((candidate) => candidate.frameScore >= MIN_BASELINE_FRAME_SCORE);
  const expectedCount = groups.reduce((sum, group) => sum + group.candidates.length, 0);
  if (candidates.length < expectedCount) {
    return undefined;
  }

  const selected = selectBaselineLayout(candidates, groups, expectedCount);
  if (!selected) {
    return undefined;
  }
  const candidateRects = assignCandidateListToGroups(groups, selected);
  if (!candidateRects || selected.length !== expectedCount) {
    return undefined;
  }

  return {
    candidateRects,
    candidateCount: candidates.length,
    matchedCount: selected.length,
    maxResidual: 0,
  };
}

/**
 * Matches a scanned page's component set to the clean baseline. A translation
 * is estimated from every possible reference/candidate pair and the best
 * one-to-one assignment is retained.
 *
 * BASIC_BOX_MATCH_V2 (default on): up to one reference per choice group, and
 * three overall, may go unmatched instead of being forced onto whatever
 * candidate is nearest -- a real frame the student's own mark swallowed is
 * common, and forcing a match used to drag the whole twelve-box layout onto
 * the field-name glyphs beside the boxes instead (cycle 2 order, "확정된
 * 사실" #2). A candidate's distance cost is weighted by how box-like its
 * printed frame looks, and a small-shift assignment is preferred outright
 * over a larger one unless the larger one is markedly cheaper. See
 * matchReferencesToCandidates. BASIC_BOX_MATCH_V2=0 restores the exact-count
 * matcher: every one of the twelve boxes must be matched to something,
 * unweighted, at the seed with the least total distance.
 */
export interface MatchBasicCheckboxesOptions {
  /** True for a photographed sheet rather than a scanned one. Scopes out
   * BASIC_BOX_MATCH_V2's missing-tolerant assignment by default -- see
   * isBasicBoxMatchV2EnabledFor -- since it measured a new wrong value and a
   * lost correct cell on the photo judging sample (2026-09-05 follow-up). */
  photoProvenance?: boolean;
}

export function matchBasicCheckboxes(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  baselineImage: ImageAnalysisData,
  baselineCandidateRects: Record<string, PixelRect[]>,
  options: MatchBasicCheckboxesOptions = {},
): BasicCheckboxGridDetection | undefined {
  const candidates = detectBasicCheckboxCandidates(image, true, true);
  const references = flattenGroupRects(groups, baselineCandidateRects, baselineImage);
  if (!references) {
    return undefined;
  }

  const match = matchReferencesToCandidates(references, candidates, groups, options.photoProvenance ?? false);
  if (!match || match.matches.length !== references.length) {
    return undefined;
  }

  const fitted = constrainMatchesToLayout(image, references, candidates, match.matches);
  if (!fitted) {
    return undefined;
  }
  const overrides = splitIntoGroups(groups, fitted.rects);
  const corrections = splitIntoGroups(groups, fitted.corrections);
  if (!overrides || !corrections) {
    return undefined;
  }
  const moved = fitted.corrections.filter((distance) => distance > 0);
  const movedNote = moved.length > 0
    ? ` ${moved.length} disagreed with that layout and were placed where it predicts (worst ${Math.max(...moved).toFixed(1)}px).`
    : '';
  // Section D: only the V2 path (matchReferencesToCandidates) fills in
  // missingCount, so this stays empty -- and the diagnostic stays byte
  // identical to before this cycle -- whenever BASIC_BOX_MATCH_V2=0.
  const v2Note = match.missingCount !== undefined
    ? ` translation=${match.translation.x.toFixed(4)},${match.translation.y.toFixed(4)}`
      + ` missing=${match.missingCount} frameMean=${(match.frameMean ?? 0).toFixed(3)}`
      + ` altSmall=${match.smallCandidateFound ? (match.usedLargeShift ? 'found,large-won' : 'used') : 'none'}.`
    : '';
  return {
    overrides,
    candidateCount: candidates.length,
    matchedCount: match.matches.length,
    maxResidual: match.maxDistance,
    translation: match.translation,
    corrections,
    diagnostic: `Checkbox geometry matched ${match.matches.length}/${references.length} candidates; max normalized residual ${match.maxDistance.toFixed(4)}.${movedNote}${v2Note}`,
  };
}

/**
 * Multiples of the page's own placement spread beyond which a box counts as
 * disagreeing with the layout rather than as ordinary jitter. For a normal
 * spread the median absolute deviation is about two thirds of a standard
 * deviation, so this is the usual clear-outlier line at roughly 2.7 sigma.
 * The distance it is applied to is measured on the page, not chosen here.
 */
const LAYOUT_OUTLIER_FACTOR = 4;

/**
 * The twelve boxes are one rigid layout. The blank form fixes where they sit
 * relative to each other, and a page can only shift that layout as a whole --
 * which is exactly the single translation the match already estimates, and
 * then discards, placing every window on its own matched candidate however
 * far that candidate is from where the layout says the box is. A window
 * thrown far enough lands on unrelated print, and the field it belongs to is
 * then refused for appearing to hold two marks.
 *
 * So every box is answerable to the other eleven. The translation is
 * re-estimated as the median of the twelve residuals, which a minority of
 * thrown boxes cannot move, and the spread of those residuals about that
 * median is the page's own placement accuracy -- tight on a clean scan, wider
 * on a poor one, measured either way rather than assumed. A box further out
 * than that spread allows is not believed: it is re-matched to a candidate
 * sitting where the layout predicts, and placed there outright when no
 * candidate is. A page whose boxes do not mostly agree has no layout left to
 * appeal to and is rejected entirely.
 */
function constrainMatchesToLayout(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  references: NormalizedPoint[],
  candidates: BasicCheckboxCandidate[],
  matches: Match[],
): { rects: PixelRect[]; corrections: number[] } | undefined {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (matches.length !== references.length || width <= 0 || height <= 0) {
    return undefined;
  }

  // A `missing` match (BASIC_BOX_MATCH_V2, Section A) never had a candidate
  // to begin with; it is left `undefined` here on purpose and falls into the
  // "disagrees with the layout" branch below -- the same branch a genuinely
  // mismatched candidate already fell into before this cycle. Everything in
  // this function reduces to the pre-cycle-2 computation when no match is
  // missing, since `matches[index].missing` is then always falsy.
  const matched = matches.map((match) => (match.missing ? undefined : candidates[match.candidateIndex]));
  if (matched.some((candidate, index) => !candidate && !matches[index].missing)) {
    return undefined;
  }

  const residualX = matched.map((candidate, index) => (candidate ? candidate.center.x - references[index].x : NaN));
  const residualY = matched.map((candidate, index) => (candidate ? candidate.center.y - references[index].y : NaN));
  const shiftX = median(residualX.filter((value) => !Number.isNaN(value)));
  const shiftY = median(residualY.filter((value) => !Number.isNaN(value)));
  const deviationX = residualX.map((value) => Math.abs(value - shiftX));
  const deviationY = residualY.map((value) => Math.abs(value - shiftY));
  // Floored at one page pixel: nothing locates a box centre more finely than
  // that, so a smaller disagreement is never evidence of a wrong match.
  const limitX = Math.max(LAYOUT_OUTLIER_FACTOR * median(deviationX.filter((value) => !Number.isNaN(value))), 1 / width);
  const limitY = Math.max(LAYOUT_OUTLIER_FACTOR * median(deviationY.filter((value) => !Number.isNaN(value))), 1 / height);

  // NaN comparisons are always false, so a missing reference never "agrees"
  // and always takes the layout-predicted placement below.
  const agrees = references.map((_, index) => deviationX[index] <= limitX && deviationY[index] <= limitY);
  if (agrees.filter(Boolean).length * 2 <= references.length) {
    return undefined;
  }

  const agreeing = matched.filter((candidate, index): candidate is BasicCheckboxCandidate => Boolean(candidate) && agrees[index]);
  const boxWidth = median(agreeing.map((candidate) => candidate.rect.right - candidate.rect.left));
  const boxHeight = median(agreeing.map((candidate) => candidate.rect.bottom - candidate.rect.top));
  const used = new Set(matches.filter((_, index) => agrees[index]).map((match) => match.candidateIndex));

  const rects: PixelRect[] = [];
  const corrections: number[] = [];
  for (let index = 0; index < references.length; index += 1) {
    if (agrees[index]) {
      rects.push(matched[index]!.rect);
      corrections.push(0);
      continue;
    }

    const predicted = { x: references[index].x + shiftX, y: references[index].y + shiftY };
    let replacementIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (used.has(candidateIndex)) continue;
      const offsetX = Math.abs(candidates[candidateIndex].center.x - predicted.x);
      const offsetY = Math.abs(candidates[candidateIndex].center.y - predicted.y);
      if (offsetX > limitX || offsetY > limitY) continue;
      const distance = offsetX * width + offsetY * height;
      if (distance < bestDistance) {
        bestDistance = distance;
        replacementIndex = candidateIndex;
      }
    }
    if (replacementIndex >= 0) {
      used.add(replacementIndex);
    }

    const placed = replacementIndex >= 0
      ? candidates[replacementIndex].rect
      : rectAroundNormalizedPoint(bounds, predicted, boxWidth, boxHeight);
    let correctionPx: number;
    if (matched[index]) {
      const movedX = (placed.left + placed.right) / 2 - (matched[index]!.rect.left + matched[index]!.rect.right) / 2;
      const movedY = (placed.top + placed.bottom) / 2 - (matched[index]!.rect.top + matched[index]!.rect.bottom) / 2;
      correctionPx = Math.sqrt(movedX * movedX + movedY * movedY);
    } else {
      // Section A: a missing reference never had a matched candidate to diff
      // against. Report the assignment's own cost (MATCH_TOLERANCE,
      // normalized) in page pixels instead, so this slot still carries a
      // non-zero correction and shows up in the diagnostic rather than
      // looking like an untouched match.
      correctionPx = Math.hypot(MATCH_TOLERANCE * width, MATCH_TOLERANCE * height);
    }
    rects.push(placed);
    corrections.push(correctionPx);
  }

  return { rects, corrections };
}

function rectAroundNormalizedPoint(
  bounds: { left: number; top: number; right: number; bottom: number },
  point: NormalizedPoint,
  boxWidth: number,
  boxHeight: number,
): PixelRect {
  const centerX = bounds.left + point.x * (bounds.right - bounds.left);
  const centerY = bounds.top + point.y * (bounds.bottom - bounds.top);
  const left = Math.round(centerX - boxWidth / 2);
  const top = Math.round(centerY - boxHeight / 2);
  return {
    left,
    top,
    right: left + Math.max(1, Math.round(boxWidth)),
    bottom: top + Math.max(1, Math.round(boxHeight)),
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function splitIntoGroups<T>(groups: ChoiceGroup[], items: T[]): Record<string, T[]> | undefined {
  const expectedCount = groups.reduce((sum, group) => sum + group.candidates.length, 0);
  if (items.length !== expectedCount) {
    return undefined;
  }
  let offset = 0;
  const result: Record<string, T[]> = {};
  for (const group of groups) {
    result[group.field] = items.slice(offset, offset + group.candidates.length);
    offset += group.candidates.length;
  }
  return result;
}

export function detectBasicCheckboxCandidates(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels' | 'contentBounds'>,
  refineMergedComponents = false,
  scanFrameWindows = false,
): BasicCheckboxCandidate[] {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const left = clamp(Math.floor(bounds.left + BASIC_REGION.left * width), 0, image.width - 1);
  const right = clamp(Math.ceil(bounds.left + BASIC_REGION.right * width), left + 1, image.width);
  const top = clamp(Math.floor(bounds.top + BASIC_REGION.top * height), 0, image.height - 1);
  const bottom = clamp(Math.ceil(bounds.top + BASIC_REGION.bottom * height), top + 1, image.height);
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  const visited = new Uint8Array(regionWidth * regionHeight);
  const queue = new Int32Array(regionWidth * regionHeight);
  const broadCandidates: BasicCheckboxCandidate[] = [];
  const thinSeeds: PixelRect[] = [];

  const localIndex = (x: number, y: number) => (y - top) * regionWidth + (x - left);
  const isDark = (x: number, y: number) => image.pixels[y * image.width + x] < DARK_THRESHOLD;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const start = localIndex(x, y);
      if (visited[start] || !isDark(x, y)) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let darkPixelCount = 0;

      while (head < tail) {
        const current = queue[head++];
        const currentX = left + (current % regionWidth);
        const currentY = top + Math.floor(current / regionWidth);
        darkPixelCount += 1;
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nextX = currentX + dx;
            const nextY = currentY + dy;
            if (nextX < left || nextX >= right || nextY < top || nextY >= bottom) continue;
            const next = localIndex(nextX, nextY);
            if (!visited[next] && isDark(nextX, nextY)) {
              visited[next] = 1;
              queue[tail++] = next;
            }
          }
        }
      }

      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const fillRatio = darkPixelCount / (componentWidth * componentHeight);
      const aspectRatio = componentWidth / componentHeight;
      const rect = { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
      const isBroadCandidate = (
        componentWidth >= MIN_COMPONENT_SIZE
        && componentWidth <= MAX_COMPONENT_SIZE
        && componentHeight >= MIN_COMPONENT_SIZE
        && componentHeight <= MAX_COMPONENT_SIZE
        && aspectRatio >= MIN_ASPECT_RATIO
        && aspectRatio <= MAX_ASPECT_RATIO
        && fillRatio >= MIN_FILL_RATIO
        && fillRatio <= MAX_FILL_RATIO
      );
      const isThinFrameFragment = (
        (componentWidth <= 8 && componentHeight >= 10 && componentHeight <= MAX_COMPONENT_SIZE)
        || (componentHeight <= 8 && componentWidth >= 10 && componentWidth <= MAX_COMPONENT_SIZE)
      );
      const isMergedFrameSeed = refineMergedComponents && (
        componentWidth >= MIN_COMPONENT_SIZE
        && componentWidth <= 60
        && componentHeight >= MIN_COMPONENT_SIZE
        && componentHeight <= 60
        && aspectRatio >= 0.5
        && aspectRatio <= 2
        && fillRatio >= 0.03
        && fillRatio <= 0.9
      );
      if (isBroadCandidate || isThinFrameFragment || isMergedFrameSeed) {
        const frameScore = calculateFrameScore(image, rect);
        const candidate = {
          rect,
          center: {
            x: ((minX + maxX + 1) / 2 - bounds.left) / width,
            y: ((minY + maxY + 1) / 2 - bounds.top) / height,
          },
          fillRatio,
          frameScore,
        };
        if (isBroadCandidate && !isMergedFrameSeed) {
          broadCandidates.push(candidate);
        } else {
          thinSeeds.push(rect);
        }
      }
    }
  }

  const candidates = broadCandidates.concat(thinSeeds
    .map((seed) => findBestFrameCandidate(image, seed, bounds))
    .filter((candidate): candidate is BasicCheckboxCandidate => candidate !== undefined));
  if (scanFrameWindows) {
    candidates.push(...scanBasicFrameWindows(image, bounds));
  }
  return deduplicateCandidates(candidates);
}

function scanBasicFrameWindows(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  bounds: { left: number; top: number; right: number; bottom: number },
): BasicCheckboxCandidate[] {
  const contentWidth = bounds.right - bounds.left;
  const contentHeight = bounds.bottom - bounds.top;
  const width = Math.round(contentWidth * 0.015);
  const height = Math.round(contentHeight * 0.0105);
  const regionLeft = Math.round(bounds.left + BASIC_REGION.left * contentWidth);
  const regionRight = Math.round(bounds.left + BASIC_REGION.right * contentWidth);
  const regionTop = Math.round(bounds.top + BASIC_REGION.top * contentHeight);
  const regionBottom = Math.round(bounds.top + BASIC_REGION.bottom * contentHeight);
  const candidates: BasicCheckboxCandidate[] = [];
  for (let top = regionTop; top + height <= regionBottom; top += 3) {
    for (let left = regionLeft; left + width <= regionRight; left += 3) {
      const rect = { left, top, right: left + width, bottom: top + height };
      const frameScore = calculateFrameScore(image, rect);
      if (frameScore < 0.35) continue;
      candidates.push({
        rect,
        center: {
          x: ((left + width / 2) - bounds.left) / contentWidth,
          y: ((top + height / 2) - bounds.top) / contentHeight,
        },
        fillRatio: 0,
        frameScore,
      });
    }
  }
  return candidates;
}

export function normalizeBasicCheckboxRects(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
  rects: PixelRect[],
): PixelRect[] {
  const bounds = getRegistrationBounds(image);
  const width = Math.max(MIN_COMPONENT_SIZE, Math.round((bounds.right - bounds.left) * 0.015));
  const height = Math.max(MIN_COMPONENT_SIZE, Math.round((bounds.bottom - bounds.top) * 0.0105));
  return rects.map((rect) => {
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const left = Math.round(centerX - width / 2);
    const top = Math.round(centerY - height / 2);
    return { left, top, right: left + width, bottom: top + height };
  });
}

export function calculateCheckboxInteriorDifference(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  actualRect: PixelRect,
  baseline: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  baselineRect: PixelRect,
): number {
  const actual = insetRect(actualRect, 3);
  const blank = insetRect(baselineRect, 4);
  const width = 8;
  const height = 8;
  let difference = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const actualX = clamp(Math.round(actual.left + (x + 0.5) * (actual.right - actual.left) / width), 0, image.width - 1);
      const actualY = clamp(Math.round(actual.top + (y + 0.5) * (actual.bottom - actual.top) / height), 0, image.height - 1);
      const blankX = clamp(Math.round(blank.left + (x + 0.5) * (blank.right - blank.left) / width), 0, baseline.width - 1);
      const blankY = clamp(Math.round(blank.top + (y + 0.5) * (blank.bottom - blank.top) / height), 0, baseline.height - 1);
      const actualInk = Math.max(0, Math.min(1, (178 - image.pixels[actualY * image.width + actualX]) / 178));
      const blankInk = Math.max(0, Math.min(1, (178 - baseline.pixels[blankY * baseline.width + blankX]) / 178));
      difference += Math.max(0, actualInk - blankInk - 0.08);
    }
  }
  return difference / (width * height);
}

/**
 * Where a scoring window sits relative to the printed box it is supposed to
 * cover, measured on the scanned page alone. Measurement only: nothing here
 * feeds a decision, it exists so the placement can be read off real scans
 * instead of inferred from a downscaled blank asset.
 *
 * A window placed on its box has the printed outline around its rim, no ink
 * reaching far past any edge, and an ink centroid near its own centre. A
 * window placed off its box has the outline running through the middle, ink
 * continuing well past one edge, and a centroid pulled that way.
 */
export interface BasicCheckboxPlacement {
  /** Dark-ink centroid inside the window, relative to the window centre, in pixels. */
  inkX: number;
  inkY: number;
  /** How far dark ink connected to the window's own ink continues past each edge, in pixels. */
  extendLeft: number;
  extendRight: number;
  extendTop: number;
  extendBottom: number;
  /** Share of the window's dark pixels lying in its central half, as a percentage. */
  corePercent: number;
  /** Dark pixels inside the window, so a percentage of almost nothing is recognisable as such. */
  darkCount: number;
}

export function measureBasicCheckboxPlacement(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  window: PixelRect,
): BasicCheckboxPlacement {
  const width = Math.max(1, window.right - window.left);
  const height = Math.max(1, window.bottom - window.top);
  const coreLeft = window.left + width * 0.25;
  const coreRight = window.right - width * 0.25;
  const coreTop = window.top + height * 0.25;
  const coreBottom = window.bottom - height * 0.25;
  let darkCount = 0;
  let coreCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = window.top; y < window.bottom; y += 1) {
    if (y < 0 || y >= image.height) continue;
    for (let x = window.left; x < window.right; x += 1) {
      if (x < 0 || x >= image.width) continue;
      if (image.pixels[y * image.width + x] >= DARK_THRESHOLD) continue;
      darkCount += 1;
      sumX += x + 0.5;
      sumY += y + 0.5;
      if (x + 0.5 >= coreLeft && x + 0.5 < coreRight && y + 0.5 >= coreTop && y + 0.5 < coreBottom) {
        coreCount += 1;
      }
    }
  }

  const inkBounds = findWindowInkBounds(image, window, Math.max(width, height));
  return {
    inkX: darkCount > 0 ? sumX / darkCount - (window.left + window.right) / 2 : 0,
    inkY: darkCount > 0 ? sumY / darkCount - (window.top + window.bottom) / 2 : 0,
    extendLeft: inkBounds ? Math.max(0, window.left - inkBounds.left) : 0,
    extendRight: inkBounds ? Math.max(0, inkBounds.right - window.right) : 0,
    extendTop: inkBounds ? Math.max(0, window.top - inkBounds.top) : 0,
    extendBottom: inkBounds ? Math.max(0, inkBounds.bottom - window.bottom) : 0,
    corePercent: darkCount > 0 ? Math.round((coreCount / darkCount) * 100) : 0,
    darkCount,
  };
}

/**
 * Bounding box of the ink that is 8-connected to any dark pixel inside the
 * window, searched no further than one window away on each side. A printed
 * outline the window only partly covers reaches past the edge it overhangs.
 */
function findWindowInkBounds(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  window: PixelRect,
  margin: number,
): PixelRect | undefined {
  const left = clamp(window.left - margin, 0, image.width - 1);
  const right = clamp(window.right + margin, left + 1, image.width);
  const top = clamp(window.top - margin, 0, image.height - 1);
  const bottom = clamp(window.bottom + margin, top + 1, image.height);
  const bandWidth = right - left;
  const bandHeight = bottom - top;
  const visited = new Uint8Array(bandWidth * bandHeight);
  const queue: number[] = [];
  const isDark = (x: number, y: number) => image.pixels[y * image.width + x] < DARK_THRESHOLD;

  for (let y = Math.max(top, window.top); y < Math.min(bottom, window.bottom); y += 1) {
    for (let x = Math.max(left, window.left); x < Math.min(right, window.right); x += 1) {
      const index = (y - top) * bandWidth + (x - left);
      if (visited[index] || !isDark(x, y)) continue;
      visited[index] = 1;
      queue.push(index);
    }
  }
  if (queue.length === 0) {
    return undefined;
  }

  let minX = right;
  let maxX = left;
  let minY = bottom;
  let maxY = top;
  while (queue.length > 0) {
    const current = queue.pop()!;
    const currentX = left + (current % bandWidth);
    const currentY = top + Math.floor(current / bandWidth);
    minX = Math.min(minX, currentX);
    maxX = Math.max(maxX, currentX);
    minY = Math.min(minY, currentY);
    maxY = Math.max(maxY, currentY);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const nextX = currentX + offsetX;
        const nextY = currentY + offsetY;
        if (nextX < left || nextX >= right || nextY < top || nextY >= bottom) continue;
        const next = (nextY - top) * bandWidth + (nextX - left);
        if (visited[next] || !isDark(nextX, nextY)) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }

  return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
}

function insetRect(rect: PixelRect, inset: number): PixelRect {
  const left = Math.min(rect.left + inset, rect.right - 1);
  const top = Math.min(rect.top + inset, rect.bottom - 1);
  const right = Math.max(left + 1, rect.right - inset);
  const bottom = Math.max(top + 1, rect.bottom - inset);
  return { left, top, right, bottom };
}

function flattenGroupRects(
  groups: ChoiceGroup[],
  candidateRects: Record<string, PixelRect[]>,
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'contentBounds'>,
): NormalizedPoint[] | undefined {
  const bounds = getRegistrationBounds(image);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const references: NormalizedPoint[] = [];
  for (const group of groups) {
    const rects = candidateRects[group.field];
    if (!rects || rects.length !== group.candidates.length) {
      return undefined;
    }
    for (const rect of rects) {
      references.push({
        x: ((rect.left + rect.right) / 2 - bounds.left) / width,
        y: ((rect.top + rect.bottom) / 2 - bounds.top) / height,
      });
    }
  }
  return references;
}

function assignCandidateListToGroups(
  groups: ChoiceGroup[],
  candidates: BasicCheckboxCandidate[],
): Record<string, PixelRect[]> | undefined {
  const expectedCount = groups.reduce((sum, group) => sum + group.candidates.length, 0);
  if (candidates.length !== expectedCount) {
    return undefined;
  }

  let offset = 0;
  const result: Record<string, PixelRect[]> = {};
  for (const group of groups) {
    result[group.field] = candidates
      .slice(offset, offset + group.candidates.length)
      .map((candidate) => candidate.rect);
    offset += group.candidates.length;
  }
  return result;
}

function selectBaselineLayout(
  candidates: BasicCheckboxCandidate[],
  groups: ChoiceGroup[],
  expectedCount: number,
): BasicCheckboxCandidate[] | undefined {
  const rows = clusterRows(candidates);
  const expectedRowCount = countTemplateRows(groups);
  let best: { rows: BasicCheckboxCandidate[][]; score: number } | undefined;

  const visit = (rowIndex: number, selected: BasicCheckboxCandidate[][], count: number, score: number) => {
    if (count > expectedCount || selected.length > expectedRowCount) return;
    if (rowIndex === rows.length) {
      if (count === expectedCount && selected.length === expectedRowCount && (!best || score > best.score)) {
        best = { rows: selected, score };
      }
      return;
    }

    visit(rowIndex + 1, selected, count, score);
    const row = rows[rowIndex];
    visit(
      rowIndex + 1,
      [...selected, row],
      count + row.length,
      score + row.reduce((sum, candidate) => sum + candidate.frameScore, 0),
    );
  };
  visit(0, [], 0, 0);

  if (!best) return undefined;
  return best.rows
    .flatMap((row) => row.slice().sort((first, second) => first.center.x - second.center.x));
}

function clusterRows(candidates: BasicCheckboxCandidate[]): BasicCheckboxCandidate[][] {
  const sorted = candidates.slice().sort((first, second) => first.center.y - second.center.y);
  const rows: BasicCheckboxCandidate[][] = [];
  for (const candidate of sorted) {
    const row = rows[rows.length - 1];
    const rowCentre = row && row.reduce((sum, item) => sum + item.center.y, 0) / row.length;
    if (!row || Math.abs(candidate.center.y - rowCentre) > ROW_CLUSTER_TOLERANCE) {
      rows.push([candidate]);
    } else {
      row.push(candidate);
    }
  }
  return rows;
}

function countTemplateRows(groups: ChoiceGroup[]): number {
  const ys = groups
    .flatMap((group) => group.candidates.map((candidate) => candidate.rect.y + candidate.rect.height / 2))
    .sort((first, second) => first - second);
  let count = 0;
  let previous: number | undefined;
  for (const y of ys) {
    if (previous === undefined || Math.abs(y - previous) > ROW_CLUSTER_TOLERANCE) {
      count += 1;
    }
    previous = y;
  }
  return count;
}

function findTranslationMatch(
  references: NormalizedPoint[],
  candidates: BasicCheckboxCandidate[],
  tolerance: number,
): TranslationMatch | undefined {
  if (references.length === 0 || candidates.length < references.length) {
    return undefined;
  }

  const candidatePoints = candidates.map((candidate) => candidate.center);
  const seeds: NormalizedPoint[] = [{ x: 0, y: 0 }];
  for (const reference of references) {
    for (const candidate of candidatePoints) {
      const translation = { x: candidate.x - reference.x, y: candidate.y - reference.y };
      if (Math.abs(translation.x) <= MAX_TRANSLATION && Math.abs(translation.y) <= MAX_TRANSLATION) {
        seeds.push(translation);
      }
    }
  }

  let best: TranslationMatch | undefined;
  for (const translation of seeds) {
    const match = assignCandidates(references, candidatePoints, translation, tolerance);
    if (!match) continue;
    if (!best || match.totalDistance < best.totalDistance) {
      best = { ...match, translation };
    }
  }

  return best;
}

function assignCandidates(
  references: NormalizedPoint[],
  candidates: NormalizedPoint[],
  translation: NormalizedPoint,
  tolerance: number,
): Omit<TranslationMatch, 'translation'> | undefined {
  const options = references.map((reference, referenceIndex) => candidates
    .map((candidate, candidateIndex) => ({
      candidateIndex,
      distance: distance(reference, {
        x: candidate.x - translation.x,
        y: candidate.y - translation.y,
      }),
    }))
    .filter((option) => option.distance <= tolerance)
    .sort((first, second) => first.distance - second.distance)
    .map((option) => ({ ...option, referenceIndex })));

  if (options.some((list) => list.length === 0)) {
    return undefined;
  }

  const order = options
    .map((list, referenceIndex) => ({ referenceIndex, count: list.length }))
    .sort((first, second) => first.count - second.count)
    .map(({ referenceIndex }) => referenceIndex);
  const used = new Set<number>();
  const selected: Array<Match | undefined> = Array.from({ length: references.length });
  let best: Omit<TranslationMatch, 'translation'> | undefined;

  const visit = (depth: number, totalDistance: number, maxDistance: number) => {
    if (best && totalDistance > best.totalDistance) return;
    if (depth === order.length) {
      best = {
        matches: selected.map((match) => match!),
        totalDistance,
        maxDistance,
      };
      return;
    }

    const referenceIndex = order[depth];
    for (const option of options[referenceIndex]) {
      if (used.has(option.candidateIndex)) continue;
      used.add(option.candidateIndex);
      selected[referenceIndex] = {
        candidateIndex: option.candidateIndex,
        distance: option.distance,
      };
      visit(depth + 1, totalDistance + option.distance, Math.max(maxDistance, option.distance));
      used.delete(option.candidateIndex);
      selected[referenceIndex] = undefined;
    }
  };

  visit(0, 0, 0);
  return best;
}

function distance(first: NormalizedPoint, second: NormalizedPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

/**
 * Dispatches to the exact-count matcher (byte-identical to before cycle 2) or
 * the missing-tolerant one, by BASIC_BOX_MATCH_V2 -- and, when
 * `photoProvenance` is true, scoped further by BASIC_BOX_MATCH_V2_PHOTOS
 * (see isBasicBoxMatchV2EnabledFor). Exposed via __probe so the paths can be
 * exercised directly -- on synthetic references and candidates, without a
 * rasterised page -- from tests/basicCheckboxDetection.test.ts.
 */
function matchReferencesToCandidates(
  references: NormalizedPoint[],
  candidates: BasicCheckboxCandidate[],
  groups: ChoiceGroup[],
  photoProvenance = false,
): TranslationMatch | undefined {
  if (!isBasicBoxMatchV2EnabledFor(photoProvenance)) {
    return findTranslationMatch(references, candidates, MATCH_TOLERANCE);
  }
  const groupOfReference = referenceGroupIndices(groups);
  return findTranslationMatchV2(references, candidates, MATCH_TOLERANCE, groupOfReference, groups.length);
}

/** Which choice group (by index into `groups`) each flattened reference
 * belongs to, in the same order flattenGroupRects lays references out in. */
function referenceGroupIndices(groups: ChoiceGroup[]): number[] {
  const indices: number[] = [];
  groups.forEach((group, groupIndex) => {
    for (let i = 0; i < group.candidates.length; i += 1) {
      indices.push(groupIndex);
    }
  });
  return indices;
}

/**
 * Section C (BASIC_BOX_MATCH_V2): the translation-search analogue of
 * findTranslationMatch, evaluated with assignCandidatesWithMissing instead of
 * assignCandidates. Seeds at or under SMALL_TRANSLATION_LIMIT are preferred
 * outright; a larger-shift seed's assignment is adopted only when its
 * weighted cost clears getLargeShiftMargin() below the best small-shift one,
 * so a page whose printed boxes sit essentially where the blank form says
 * they do is never dragged onto a coincidentally cheaper label-glyph column.
 */
function findTranslationMatchV2(
  references: NormalizedPoint[],
  candidates: BasicCheckboxCandidate[],
  tolerance: number,
  groupOfReference: number[],
  groupCount: number,
): TranslationMatch | undefined {
  if (references.length === 0) {
    return undefined;
  }

  const candidatePoints = candidates.map((candidate) => candidate.center);
  const seeds: NormalizedPoint[] = [{ x: 0, y: 0 }];
  for (const reference of references) {
    for (const point of candidatePoints) {
      const seed = { x: point.x - reference.x, y: point.y - reference.y };
      if (Math.abs(seed.x) <= MAX_TRANSLATION && Math.abs(seed.y) <= MAX_TRANSLATION) {
        seeds.push(seed);
      }
    }
  }

  const frameWeight = getFrameWeight();
  const seedMagnitude = (seed: NormalizedPoint) => Math.max(Math.abs(seed.x), Math.abs(seed.y));
  // Ascending |t|, per the order: small-shift seeds are what the rest of this
  // function treats as the default. The two best-of-bucket values below are
  // taken over the whole seed list regardless of visit order, so this only
  // affects how quickly a good bound is found, not the result.
  const orderedSeeds = seeds.slice().sort((first, second) => seedMagnitude(first) - seedMagnitude(second));

  type Assignment = NonNullable<ReturnType<typeof assignCandidatesWithMissing>>;
  let bestSmall: (Assignment & { translation: NormalizedPoint }) | undefined;
  let bestLarge: (Assignment & { translation: NormalizedPoint }) | undefined;

  for (const seed of orderedSeeds) {
    const assignment = assignCandidatesWithMissing(
      references,
      candidates,
      seed,
      tolerance,
      groupOfReference,
      groupCount,
      frameWeight,
    );
    if (!assignment) continue;
    if (seedMagnitude(seed) <= SMALL_TRANSLATION_LIMIT) {
      if (!bestSmall || assignment.weightedTotal < bestSmall.weightedTotal) {
        bestSmall = { ...assignment, translation: seed };
      }
    } else if (!bestLarge || assignment.weightedTotal < bestLarge.weightedTotal) {
      bestLarge = { ...assignment, translation: seed };
    }
  }

  const margin = getLargeShiftMargin();
  let usedLargeShift = false;
  let winner = bestSmall;
  if (bestLarge && (!bestSmall || bestLarge.weightedTotal <= bestSmall.weightedTotal * (1 - margin))) {
    winner = bestLarge;
    usedLargeShift = true;
  }
  if (!winner) {
    return undefined;
  }

  const frameScores = winner.matches
    .filter((match) => !match.missing)
    .map((match) => candidates[match.candidateIndex].frameScore);
  const frameMean = frameScores.length > 0
    ? frameScores.reduce((sum, value) => sum + value, 0) / frameScores.length
    : 0;

  return {
    translation: winner.translation,
    matches: winner.matches,
    totalDistance: winner.totalDistance,
    maxDistance: winner.maxDistance,
    missingCount: winner.missingCount,
    frameMean,
    smallCandidateFound: Boolean(bestSmall),
    usedLargeShift,
  };
}

/**
 * Section A + B (BASIC_BOX_MATCH_V2): the same one-to-one assignment as
 * assignCandidates, except a reference may be left unassigned ("missing") at
 * a flat cost of `tolerance` instead of being forced onto whatever candidate
 * happens to sit within it -- capped at MAX_MISSING_PER_GROUP per choice
 * group and MAX_MISSING_TOTAL overall, since a student marks at most one
 * option per group and leaving more than that unassigned would stop being
 * "one missed mark" and start being "no boxes detected at all". A real
 * candidate's cost is weighted by how box-like its printed frame looks
 * (Section B), so a letter glyph sitting just inside tolerance is no longer
 * indistinguishable from the box it is impersonating.
 */
function assignCandidatesWithMissing(
  references: NormalizedPoint[],
  candidates: BasicCheckboxCandidate[],
  translation: NormalizedPoint,
  tolerance: number,
  groupOfReference: number[],
  groupCount: number,
  frameWeight: number,
): { matches: Match[]; totalDistance: number; maxDistance: number; weightedTotal: number; missingCount: number } | undefined {
  const options = references.map((reference) => candidates
    .map((candidate, candidateIndex) => {
      const rawDistance = distance(reference, {
        x: candidate.center.x - translation.x,
        y: candidate.center.y - translation.y,
      });
      return {
        candidateIndex,
        distance: rawDistance,
        weighted: rawDistance * (1 + frameWeight * (1 - candidate.frameScore)),
      };
    })
    .filter((option) => option.distance <= tolerance)
    .sort((first, second) => first.weighted - second.weighted));

  // Fewest real options first, same heuristic as assignCandidates -- it only
  // affects how quickly a good bound is found, not the result, since every
  // reference can still fall back to "missing" if its budget allows.
  const order = options
    .map((list, referenceIndex) => ({ referenceIndex, count: list.length }))
    .sort((first, second) => first.count - second.count)
    .map(({ referenceIndex }) => referenceIndex);

  const used = new Set<number>();
  const missingPerGroup = new Array<number>(groupCount).fill(0);
  const selected: Array<Match | undefined> = Array.from({ length: references.length });
  let best: { matches: Match[]; totalDistance: number; maxDistance: number; weightedTotal: number; missingCount: number } | undefined;

  const visit = (
    depth: number,
    totalDistance: number,
    maxDistance: number,
    weightedTotal: number,
    missingCount: number,
  ) => {
    if (best && weightedTotal >= best.weightedTotal) return;
    if (depth === order.length) {
      best = { matches: selected.map((match) => match!), totalDistance, maxDistance, weightedTotal, missingCount };
      return;
    }

    const referenceIndex = order[depth];

    for (const option of options[referenceIndex]) {
      if (used.has(option.candidateIndex)) continue;
      used.add(option.candidateIndex);
      selected[referenceIndex] = { candidateIndex: option.candidateIndex, distance: option.distance };
      visit(
        depth + 1,
        totalDistance + option.distance,
        Math.max(maxDistance, option.distance),
        weightedTotal + option.weighted,
        missingCount,
      );
      used.delete(option.candidateIndex);
      selected[referenceIndex] = undefined;
    }

    const group = groupOfReference[referenceIndex];
    if (missingPerGroup[group] < MAX_MISSING_PER_GROUP && missingCount < MAX_MISSING_TOTAL) {
      missingPerGroup[group] += 1;
      selected[referenceIndex] = { candidateIndex: -1, distance: tolerance, missing: true };
      visit(
        depth + 1,
        totalDistance + tolerance,
        Math.max(maxDistance, tolerance),
        weightedTotal + tolerance,
        missingCount + 1,
      );
      selected[referenceIndex] = undefined;
      missingPerGroup[group] -= 1;
    }
  };

  visit(0, 0, 0, 0, 0);
  return best;
}

function findBestFrameCandidate(
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>,
  seed: PixelRect,
  bounds: { left: number; top: number; right: number; bottom: number },
): BasicCheckboxCandidate | undefined {
  const contentWidth = bounds.right - bounds.left;
  const contentHeight = bounds.bottom - bounds.top;
  const expectedWidth = Math.round(contentWidth * 0.015);
  const expectedHeight = Math.round(contentHeight * 0.0105);
  const minWidth = Math.max(MIN_COMPONENT_SIZE, expectedWidth - 2);
  const maxWidth = Math.min(MAX_COMPONENT_SIZE, expectedWidth + 2);
  const minHeight = Math.max(MIN_COMPONENT_SIZE, expectedHeight - 2);
  const maxHeight = Math.min(MAX_COMPONENT_SIZE, expectedHeight + 2);
  const seedCenterX = (seed.left + seed.right) / 2;
  const seedCenterY = (seed.top + seed.bottom) / 2;
  const offset = 4;
  let best: { rect: PixelRect; score: number } | undefined;

  for (let width = minWidth; width <= maxWidth; width += 1) {
    for (let height = minHeight; height <= maxHeight; height += 1) {
      for (let dx = -offset; dx <= offset; dx += 1) {
        for (let dy = -offset; dy <= offset; dy += 1) {
          const centerX = Math.round(seedCenterX + dx);
          const centerY = Math.round(seedCenterY + dy);
          const rect: PixelRect = {
            left: centerX - Math.floor(width / 2),
            top: centerY - Math.floor(height / 2),
            right: centerX - Math.floor(width / 2) + width,
            bottom: centerY - Math.floor(height / 2) + height,
          };
          if (rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom) {
            continue;
          }
          const score = calculateFrameScore(image, rect);
          if (!best || score > best.score) {
            best = { rect, score };
          }
        }
      }
    }
  }

  if (!best || best.score < 0.35) return undefined;
  return {
    rect: best.rect,
    center: {
      x: ((best.rect.left + best.rect.right) / 2 - bounds.left) / contentWidth,
      y: ((best.rect.top + best.rect.bottom) / 2 - bounds.top) / contentHeight,
    },
    fillRatio: 0,
    frameScore: best.score,
  };
}

function deduplicateCandidates(candidates: BasicCheckboxCandidate[]): BasicCheckboxCandidate[] {
  const sorted = candidates.slice().sort((first, second) => second.frameScore - first.frameScore);
  const selected: BasicCheckboxCandidate[] = [];
  for (const candidate of sorted) {
    const duplicate = selected.some((other) => (
      Math.abs(other.center.x - candidate.center.x) <= 0.008
      && Math.abs(other.center.y - candidate.center.y) <= 0.008
    ));
    if (!duplicate) selected.push(candidate);
  }
  return selected;
}

function calculateFrameScore(
  image: Pick<ImageAnalysisData, 'width' | 'pixels'>,
  rect: PixelRect,
): number {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width < 6 || height < 6) return 0;

  const edgeDensity = (left: number, top: number, right: number, bottom: number): number => {
    let dark = 0;
    let total = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        total += 1;
        if (image.pixels[y * image.width + x] < DARK_THRESHOLD) dark += 1;
      }
    }
    return dark / Math.max(total, 1);
  };

  const top = edgeDensity(rect.left, rect.top, rect.right - 1, Math.min(rect.top + 1, rect.bottom - 1));
  const bottom = edgeDensity(rect.left, Math.max(rect.top, rect.bottom - 2), rect.right - 1, rect.bottom - 1);
  const left = edgeDensity(rect.left, rect.top, Math.min(rect.left + 1, rect.right - 1), rect.bottom - 1);
  const right = edgeDensity(Math.max(rect.left, rect.right - 2), rect.top, rect.right - 1, rect.bottom - 1);
  const inner = edgeDensity(
    Math.min(rect.left + 2, rect.right - 1),
    Math.min(rect.top + 2, rect.bottom - 1),
    Math.max(rect.left, rect.right - 3),
    Math.max(rect.top, rect.bottom - 3),
  );
  return (top + bottom + left + right) / 4 - inner * 0.35;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Read-only handle onto module-private functions, for
 * `tests/_probe-basic-boxes.test.ts` (the first three) and
 * `tests/basicCheckboxDetection.test.ts` (cycle 2's BASIC_BOX_MATCH_V2
 * additions) only. No behaviour changes: this adds a reference to the same
 * functions the module already calls, nothing more.
 */
export const __probe = {
  findTranslationMatch,
  assignCandidates,
  flattenGroupRects,
  matchReferencesToCandidates,
  findTranslationMatchV2,
  assignCandidatesWithMissing,
  referenceGroupIndices,
  isBasicBoxMatchV2Enabled,
  isBasicBoxMatchV2EnabledFor,
};
