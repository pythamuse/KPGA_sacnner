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
  diagnostic: string;
}

interface NormalizedPoint {
  x: number;
  y: number;
}

interface Match {
  candidateIndex: number;
  distance: number;
}

interface TranslationMatch {
  translation: NormalizedPoint;
  matches: Match[];
  totalDistance: number;
  maxDistance: number;
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
 * one-to-one assignment is retained. No field or candidate receives a special
 * rule; a page is verified only when the complete 12-box pattern is present.
 */
export function matchBasicCheckboxes(
  image: ImageAnalysisData,
  groups: ChoiceGroup[],
  baselineImage: ImageAnalysisData,
  baselineCandidateRects: Record<string, PixelRect[]>,
): BasicCheckboxGridDetection | undefined {
  const candidates = detectBasicCheckboxCandidates(image, true, true);
  const references = flattenGroupRects(groups, baselineCandidateRects, baselineImage);
  if (!references) {
    return undefined;
  }

  const match = findTranslationMatch(references, candidates, MATCH_TOLERANCE);
  if (!match || match.matches.length !== references.length) {
    return undefined;
  }

  const overrides = assignRectsToGroups(groups, candidates, match.matches);
  if (!overrides) {
    return undefined;
  }
  return {
    overrides,
    candidateCount: candidates.length,
    matchedCount: match.matches.length,
    maxResidual: match.maxDistance,
    translation: match.translation,
    diagnostic: `Checkbox geometry matched ${match.matches.length}/${references.length} candidates; max normalized residual ${match.maxDistance.toFixed(4)}.`,
  };
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

function assignRectsToGroups(
  groups: ChoiceGroup[],
  candidates: BasicCheckboxCandidate[],
  matches: Match[],
): Record<string, PixelRect[]> | undefined {
  let matchIndex = 0;
  const result: Record<string, PixelRect[]> = {};
  for (const group of groups) {
    const rects: PixelRect[] = [];
    for (let index = 0; index < group.candidates.length; index += 1) {
      const match = matches[matchIndex++];
      if (!match || !candidates[match.candidateIndex]) {
        return undefined;
      }
      rects.push(candidates[match.candidateIndex].rect);
    }
    result[group.field] = rects;
  }
  return result;
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
