import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  applyTemplateRegistrationFrame,
  getRegistrationBounds,
  loadImageAnalysisData,
  type PixelRect,
} from '../src/lib/recognition/markDensity';
import { getTemplate } from '../src/lib/recognition/roiTemplates';
import { loadBlankFormBaseline } from '../src/lib/recognition/templateBaseline';
import {
  detectBasicCheckboxCandidates,
  matchBasicCheckboxes,
  __probe,
} from '../src/lib/recognition/basicCheckboxDetection';

/**
 * ONE-OFF PROBE -- delete after the round (cycle 1 basic-boxes probe,
 * Task/CYCLE1_BASIC_PROBE_AGENT_REPORT_2026-09-05.md).
 *
 * Runs the product's basic-info checkbox placement path exactly as
 * detectCheckmarks.ts:210-238 calls it (`matchBasicCheckboxes`, which calls
 * `detectBasicCheckboxCandidates` -> `findTranslationMatch` ->
 * `constrainMatchesToLayout`, basicCheckboxDetection.ts) on one already
 * -rasterised CAGI page image, and prints every stage:
 *
 *   - every detected candidate component (rect, center, fillRatio, frameScore)
 *   - the 12 baseline reference points (`flattenGroupRects`)
 *   - the translation `findTranslationMatch` actually picked, and its
 *     total/max residual
 *   - the best alternative among "small translation" seeds only
 *     (|x|,|y| <= MATCH_TOLERANCE/2), if one produces a full assignment
 *   - `matchBasicCheckboxes`' final per-field rects, corrections and
 *     diagnostic string
 *
 * ...and writes one annotated PNG of the basic-info band: blue = baseline
 * reference boxes projected into this page's own registered bounds, green =
 * every detected candidate (labelled with its frameScore), red =
 * `matchBasicCheckboxes`' final scoring windows.
 *
 * Nothing here is interpreted or judged -- read the console output and the
 * PNG.
 *
 *   IMAGE=..jpg OUT=.. npx vitest run tests/_probe-basic-boxes.test.ts
 */

const IMAGE = process.env.IMAGE;
const OUT = process.env.OUT;
const run = IMAGE && OUT ? describe : describe.skip;

// Mirrors the module-private constant at
// src/lib/recognition/basicCheckboxDetection.ts:68. Not exported -- kept as a
// literal here (with this pointer) rather than adding another export.
const MATCH_TOLERANCE = 0.018;
const SMALL_TRANSLATION_LIMIT = MATCH_TOLERANCE / 2;

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Maps a rect normalized against `from` into the pixel space of `to`. */
function projectRect(rect: PixelRect, from: Bounds, to: Bounds): PixelRect {
  const fromWidth = from.right - from.left;
  const fromHeight = from.bottom - from.top;
  const toWidth = to.right - to.left;
  const toHeight = to.bottom - to.top;
  return {
    left: to.left + ((rect.left - from.left) / fromWidth) * toWidth,
    right: to.left + ((rect.right - from.left) / fromWidth) * toWidth,
    top: to.top + ((rect.top - from.top) / fromHeight) * toHeight,
    bottom: to.top + ((rect.bottom - from.top) / fromHeight) * toHeight,
  };
}

function fmtRect(rect: PixelRect): string {
  return `${rect.left.toFixed(1)},${rect.top.toFixed(1)}-${rect.right.toFixed(1)},${rect.bottom.toFixed(1)}`;
}

run('basic checkbox placement', () => {
  it('prints candidates, references, translation match and final windows; writes an annotated crop', async () => {
    fs.mkdirSync(OUT!, { recursive: true });
    const template = getTemplate('cagi');
    const basicGroups = template.choiceGroups.filter((group) => group.field.startsWith('basic.'));

    // Same order as detectCheckmarks.ts:210-236: load, register. The
    // registered image is exactly what the product passes into
    // matchBasicCheckboxes -- selectGridDetectionStream's `scoringImage` is
    // always the raw registered image for a scan (detectCheckmarks.ts:1006-
    // 1007: it never flattens when photoProvenance is false, which it is for
    // every path that reaches this probe).
    const raw = await loadImageAnalysisData(IMAGE!);
    const image = applyTemplateRegistrationFrame(raw, template.registrationFrame);
    const baseline = await loadBlankFormBaseline('cagi');
    const basicCheckboxCandidateRects = baseline?.basicCheckboxCandidateRects;
    console.info(`[basic-boxes] image=${IMAGE}`);

    if (!baseline || !basicCheckboxCandidateRects) {
      console.info('[basic-boxes] loadBlankFormBaseline(cagi) has no basicCheckboxCandidateRects -- cannot run matchBasicCheckboxes');
      return;
    }
    const baselineImage = baseline.image;

    const bounds = getRegistrationBounds(image);
    const baselineBounds = getRegistrationBounds(baselineImage);
    console.info(`[basic-boxes] bounds=${JSON.stringify(bounds)} source=${image.contentBoundsSource} baselineBounds=${JSON.stringify(baselineBounds)}`);

    // 1a. Candidates -- the exact call matchBasicCheckboxes makes
    // (basicCheckboxDetection.ts:119).
    const candidates = detectBasicCheckboxCandidates(image, true, true);
    console.info(`[basic-boxes] candidates=${candidates.length}`);
    candidates.forEach((candidate, index) => {
      console.info(
        `[basic-boxes] candidate#${index} rect=${fmtRect(candidate.rect)}`
        + ` center=${candidate.center.x.toFixed(4)},${candidate.center.y.toFixed(4)}`
        + ` fill=${candidate.fillRatio.toFixed(3)} frameScore=${candidate.frameScore.toFixed(3)}`,
      );
    });

    // 1b. The 12 baseline reference points (basicCheckboxDetection.ts:634-656).
    const references = __probe.flattenGroupRects(basicGroups, basicCheckboxCandidateRects, baselineImage);
    if (!references) {
      console.info('[basic-boxes] flattenGroupRects returned undefined (group/candidate-count mismatch)');
      return;
    }
    references.forEach((reference, index) => {
      console.info(`[basic-boxes] reference#${index} normalized=${reference.x.toFixed(4)},${reference.y.toFixed(4)}`);
    });

    // 1c. The translation findTranslationMatch actually picked.
    const match = __probe.findTranslationMatch(references, candidates, MATCH_TOLERANCE);
    if (match) {
      console.info(
        `[basic-boxes] chosen translation=${match.translation.x.toFixed(4)},${match.translation.y.toFixed(4)}`
        + ` totalDistance=${match.totalDistance.toFixed(4)} maxDistance=${match.maxDistance.toFixed(4)}`
        + ` matches=${match.matches.length}/${references.length}`,
      );
    } else {
      console.info('[basic-boxes] findTranslationMatch returned undefined (no full 12-box assignment within tolerance)');
    }

    // 1d. Best "small translation" alternative: the same seed construction as
    // findTranslationMatch (basicCheckboxDetection.ts:752-760: every
    // reference/candidate pair's implied translation), restricted to seeds
    // with |x|,|y| <= MATCH_TOLERANCE/2.
    const candidatePoints = candidates.map((candidate) => candidate.center);
    const smallSeeds: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }];
    for (const reference of references) {
      for (const point of candidatePoints) {
        const translation = { x: point.x - reference.x, y: point.y - reference.y };
        if (Math.abs(translation.x) <= SMALL_TRANSLATION_LIMIT && Math.abs(translation.y) <= SMALL_TRANSLATION_LIMIT) {
          smallSeeds.push(translation);
        }
      }
    }
    let bestSmall: { translation: { x: number; y: number }; totalDistance: number; maxDistance: number; matchCount: number } | undefined;
    for (const translation of smallSeeds) {
      const assignment = __probe.assignCandidates(references, candidatePoints, translation, MATCH_TOLERANCE);
      if (!assignment) continue;
      if (!bestSmall || assignment.totalDistance < bestSmall.totalDistance) {
        bestSmall = {
          translation,
          totalDistance: assignment.totalDistance,
          maxDistance: assignment.maxDistance,
          matchCount: assignment.matches.length,
        };
      }
    }
    console.info(`[basic-boxes] small-translation seeds tried=${smallSeeds.length} (|x|,|y| <= ${SMALL_TRANSLATION_LIMIT})`);
    if (bestSmall) {
      console.info(
        `[basic-boxes] best small translation=${bestSmall.translation.x.toFixed(4)},${bestSmall.translation.y.toFixed(4)}`
        + ` totalDistance=${bestSmall.totalDistance.toFixed(4)} maxDistance=${bestSmall.maxDistance.toFixed(4)}`
        + ` matches=${bestSmall.matchCount}/${references.length}`,
      );
    } else {
      console.info('[basic-boxes] no small-translation seed produced a full 12-box assignment');
    }

    // 2. The product's own final result (basicCheckboxDetection.ts:113-152).
    const result = matchBasicCheckboxes(image, basicGroups, baselineImage, basicCheckboxCandidateRects);
    if (!result) {
      console.info('[basic-boxes] matchBasicCheckboxes returned undefined');
    } else {
      console.info(`[basic-boxes] matchBasicCheckboxes diagnostic=${result.diagnostic}`);
      console.info(
        `[basic-boxes] matchedCount=${result.matchedCount} maxResidual=${result.maxResidual.toFixed(4)}`
        + ` translation=${result.translation.x.toFixed(4)},${result.translation.y.toFixed(4)}`,
      );
      for (const group of basicGroups) {
        const rects = result.overrides[group.field] || [];
        const corrections = result.corrections[group.field] || [];
        rects.forEach((rect, index) => {
          console.info(`[basic-boxes] final ${group.field}[${index}] rect=${fmtRect(rect)} correction=${(corrections[index] ?? 0).toFixed(2)}px`);
        });
      }
    }

    // 3. Annotated PNG.
    const blueRects = basicGroups.flatMap((group) => (basicCheckboxCandidateRects[group.field] || [])
      .map((rect) => projectRect(rect, baselineBounds, bounds)));
    if (blueRects.length === 0) {
      console.info('[basic-boxes] no baseline reference rects for these groups -- PNG not written');
      return;
    }

    const cropTop = Math.max(0, Math.floor(Math.min(...blueRects.map((rect) => rect.top))) - 40);
    const cropBottom = Math.min(image.height, Math.ceil(Math.max(...blueRects.map((rect) => rect.bottom))) + 40);
    const cropLeft = Math.max(0, Math.floor(bounds.left));
    const cropRight = Math.min(image.width, Math.ceil(bounds.right));
    const cropWidth = cropRight - cropLeft;
    const cropHeight = cropBottom - cropTop;

    const toLocal = (rect: PixelRect) => ({
      left: rect.left - cropLeft,
      top: rect.top - cropTop,
      right: rect.right - cropLeft,
      bottom: rect.bottom - cropTop,
    });

    const finalRects: PixelRect[] = result
      ? basicGroups.flatMap((group) => result.overrides[group.field] || [])
      : [];

    const svgParts: string[] = [`<svg width="${cropWidth}" height="${cropHeight}" xmlns="http://www.w3.org/2000/svg">`];
    for (const rect of blueRects) {
      const local = toLocal(rect);
      svgParts.push(`<rect x="${local.left}" y="${local.top}" width="${local.right - local.left}" height="${local.bottom - local.top}" fill="none" stroke="#1e6fff" stroke-width="1.5"/>`);
    }
    for (const candidate of candidates) {
      const local = toLocal(candidate.rect);
      if (local.right < 0 || local.left > cropWidth || local.bottom < 0 || local.top > cropHeight) continue;
      svgParts.push(`<rect x="${local.left}" y="${local.top}" width="${local.right - local.left}" height="${local.bottom - local.top}" fill="none" stroke="#00b300" stroke-width="1"/>`);
      svgParts.push(`<text x="${local.left}" y="${Math.max(9, local.top - 2)}" font-size="9" fill="#00b300">${candidate.frameScore.toFixed(2)}</text>`);
    }
    for (const rect of finalRects) {
      const local = toLocal(rect);
      svgParts.push(`<rect x="${local.left}" y="${local.top}" width="${local.right - local.left}" height="${local.bottom - local.top}" fill="none" stroke="#e11" stroke-width="1.5"/>`);
    }
    svgParts.push('</svg>');
    const overlay = Buffer.from(svgParts.join(''));

    // Two stages on purpose (mirrors tests/_probe-grid-crops.test.ts): sharp
    // applies resize before composite regardless of call order, so crop +
    // overlay happen first at native scale in one pipeline, and the combined
    // PNG is resized 2x as a separate second pass.
    const cropped = await sharp(image.pixels, { raw: { width: image.width, height: image.height, channels: 1 } })
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png()
      .toBuffer();
    // Two sample sets share page numbers (browser-19/cagi/page-0002.jpg vs.
    // scanpages-set1/cagi/page-0002.jpg), so the basename alone collides.
    // Tag the output with the last two path segments to disambiguate.
    const segments = IMAGE!.split(/[\\/]+/).filter(Boolean);
    const tag = segments.slice(-3).join('-').replace(/\.[^./]+$/, '');
    const outPath = path.join(OUT!, `${tag}-basic.png`);
    await sharp(cropped)
      .resize({ width: cropWidth * 2, height: cropHeight * 2, kernel: 'nearest' })
      .png()
      .toFile(outPath);
    console.info(`[basic-boxes] wrote ${outPath} crop=${cropWidth}x${cropHeight} (2x -> ${cropWidth * 2}x${cropHeight * 2})`);
  }, 120_000);
});
