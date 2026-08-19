import sharp from 'sharp';
import os from 'os';
import path from 'path';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { ImageAnalysisData, PixelRect } from './markDensity';

export interface OcrTextLine {
  y: number;
  confidence: number;
}

export interface OcrOptions {
  deadlineAt?: number;
}

export interface DigitOcrOptions extends OcrOptions {}

export type DigitOcrStatus =
  | 'accepted'
  | 'invalid_input'
  | 'worker_pending'
  | 'deadline_exhausted'
  | 'invalid_crop'
  | 'no_handwriting_found'
  | 'timeout_or_error'
  | 'parse_or_confidence_rejected';

export interface DigitOcrResult {
  value?: number;
  status: DigitOcrStatus;
  diagnostic: string;
}

export interface DigitTemplateReference {
  image: Pick<ImageAnalysisData, 'width' | 'height' | 'pixels'>;
  rect: PixelRect;
}

const MIN_CONFIDENCE = 30;
// Handwritten digits are optional enrichment. A value below this level is
// shown as blank for manual review instead of being written as a wrong age.
const MIN_DIGIT_CONFIDENCE = 60;
const MIN_LINE_HEIGHT = 6;
const GROUP_DISTANCE_PX = 8;
// Emergency fix (see Task/OCR_ANCHORED_ROW_DETECTION.md cycle 1 feedback): the original
// per-stage 60s timeouts (60s worker init + 60s recognize) let a single /api/recognize
// request take 184s in production, because Vercel serverless containers are ephemeral and
// tesseract's Korean model has to be re-initialized from a cold cache far more often than
// in local testing. OCR is a "nice to have" anchor -- it must never cost the user-facing
// request more than a small, bounded amount of time. One short budget covers worker
// creation + recognition together; if it's not done in time, this silently returns []
// and the caller falls back to the existing pixel-line detector, exactly as on any other
// OCR failure.
// Korean row-anchor OCR remains optional and intentionally short. Age uses a
// separate English digit worker below; loading a Korean model just to read two
// handwritten digits was the source of repeated empty age values on cold
// serverless instances.
const OCR_TOTAL_TIMEOUT_MS = 2_500;
const DIGIT_OCR_TOTAL_TIMEOUT_MS = 6_000;
const OCR_CACHE_PATH = path.join(os.tmpdir(), 'gambling-prevention-tesseract-cache');
const DIGIT_OCR_CACHE_PATH = path.join(os.tmpdir(), 'gambling-prevention-digit-tesseract-cache');
// `cachePath` points at the container's temp directory, which is empty on every
// cold start, so tesseract.js re-downloaded the 5MB English model from its CDN
// for each new serverless instance. That never finished inside the 6s first-page
// budget, and once the first attempt timed out, `digitWorkerPromise` stayed
// pending so every later page short-circuited on the `worker_pending` guard --
// age came back blank for all 19 pages of a real batch. The model is committed
// beside the blank-form assets and traced into the deployment bundle
// (next.config.mjs), so worker creation is now a local file read.
const DIGIT_OCR_LANG_PATH = path.join(process.cwd(), 'src', 'lib', 'recognition', 'assets');

// --- Age crop preprocessing ---------------------------------------------------
// Measured on the deployment raster the age crop is about 68x16px, so it is
// enlarged before anything else looks at it. The factor is applied to both axes
// equally: the previous code clamped width and height independently, which
// stretched the box 1.3x taller than wide and deformed every glyph.
const DIGIT_MIN_UPSCALE = 4;
const DIGIT_MIN_WORKING_WIDTH = 320;
const DIGIT_MIN_WORKING_HEIGHT = 96;
// Ink is anything materially darker than the blank form at the same position.
// The old floor (24) plus a 5x gain pushed faint pencil back above the fixed
// 190 cut, which is how a handwritten "5" arrived as a handful of specks.
const DIGIT_TEMPLATE_INK_FLOOR = 12;
const DIGIT_TEMPLATE_INK_GAIN = 3;
// A crop with essentially nothing in it is reported as empty instead of being
// handed to OCR, so an unfilled box can never be turned into a number.
const DIGIT_MIN_INK_FRACTION = 0.004;
// A printed rule runs across most of the box; a handwritten stroke does not.
const DIGIT_RULE_RUN_FRACTION = 0.55;
// A scanned rule is not perfectly horizontal, and the crop is enlarged about
// six times before anything looks at it, so half a pixel of skew on the page
// becomes several pixels here. Measured on real scans the rule then never has a
// run of 55% of the width inside any single row -- it is broken into thirds,
// each of which falls under the length test -- and it survived as a component
// spanning the entire working image. The rule is therefore fitted as a line
// with a slope, not as a row. The bound is the total vertical drift allowed
// across the full width.
const DIGIT_RULE_MAX_SLANT_FRACTION = 0.12;
// A printed rule is thin. Only ink columns at most this tall are erased where
// the fitted line passes, so a digit standing on the rule keeps its stem: the
// ink column at the crossing runs the height of the stroke, far past this.
const DIGIT_RULE_MAX_THICKNESS_FRACTION = 0.14;
// Two digits sit side by side in this box, so no single connected shape inside
// it can cover the field from one edge to the other -- not even two digits
// written into each other. Anything that does is printed structure, possibly
// with handwriting fused onto it.
const DIGIT_MAX_STROKE_WIDTH_FRACTION = 0.9;
// How much ink may lie beyond a printed line before it stops being a wall of
// the box and starts being a rule the digits are written across. Beyond a real
// wall there is only the outside of the field, so this is scanner speckle and
// the odd stroke overshooting the box, not a digit.
const DIGIT_WALL_OUTSIDE_INK_FRACTION = 0.1;
// Among the ten digits only `1` can be drawn this narrow. Every other digit
// carries a horizontal traverse -- a bowl, a crossbar, a top bar -- whose length
// is a dimension of the glyph rather than of the pen, and in any legible hand
// that traverse is at least a third of the glyph's height. `1` has no traverse,
// so its width is the pen's width plus whatever slant the writer gives it. The
// bound sits below the floor the other nine can reach, not at it.
const DIGIT_ONE_MAX_ASPECT = 0.3;
// Two digits written into one box share a baseline and a cap height. A fragment
// of a broken glyph, a stray tick or a piece of printed structure does not, so a
// shape that is not about as tall as its neighbour is not the other digit.
const DIGIT_PAIR_HEIGHT_MATCH = 0.7;
// The box's own left/right edges and its dashed centre divider are thin columns
// spanning nearly the full height. Handwritten digits are wider than this.
const DIGIT_RULE_COLUMN_HEIGHT_FRACTION = 0.85;
const DIGIT_RULE_COLUMN_WIDTH_FRACTION = 0.025;
// Dashes left by the centre divider and scanner speckle are far shorter than a
// digit written to fill the box.
const DIGIT_MIN_STROKE_HEIGHT_FRACTION = 0.3;
// The strokes are handed over at a fixed height with a white border around
// them, rather than at whatever size the crop happened to produce with glyphs
// touching all four edges. Measured on the synthetic bench: below a border of
// roughly half the stroke height every reading collapsed, and 40-56px strokes
// all behaved the same, so the middle of that plateau is used.
const DIGIT_OCR_STROKE_HEIGHT = 48;
const DIGIT_OCR_PADDING_RATIO = 0.75;
const DIGIT_OCR_DPI = 300;

let workerPromise: Promise<Worker> | null = null;
let workerReady = false;
let digitWorkerPromise: Promise<Worker> | null = null;
let digitWorkerReady = false;
// Serialises the digit worker's set-parameters/recognize pairs. See
// `readDigitStrokes`.
let digitOcrQueue: Promise<unknown> = Promise.resolve();
const ocrResultCache = new WeakMap<Buffer, Map<string, Promise<OcrTextLine[]>>>();

export async function detectOcrTextLines(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
  options?: OcrOptions,
): Promise<OcrTextLine[]> {
  try {
    if (!Buffer.isBuffer(imageBuffer) || imageWidth <= 0 || imageHeight <= 0) {
      return [];
    }

    // If a previous call in this container already kicked off worker init and it's still
    // not ready, don't pay the timeout again -- a single /api/recognize request can call
    // this up to three times (CAGI rows + two satisfaction groups), and re-waiting the full
    // budget each time is what turned one slow cold start into 3x the latency in production.
    // Only the very first attempt per container waits; the rest fall back immediately until
    // the background init actually finishes (at which point they get the fast, warm path).
    if (workerPromise && !workerReady) {
      return [];
    }

    const crop = buildCropBounds(imageWidth, imageHeight, searchTop, searchBottom, xLeft, xRight);
    if (!crop) {
      return [];
    }

    let imageCache = ocrResultCache.get(imageBuffer);
    if (!imageCache) {
      imageCache = new Map();
      ocrResultCache.set(imageBuffer, imageCache);
    }

    const cacheKey = `${crop.left}:${crop.top}:${crop.width}:${crop.height}`;
    const remainingMs = options?.deadlineAt
      ? Math.min(OCR_TOTAL_TIMEOUT_MS, options.deadlineAt - Date.now())
      : OCR_TOTAL_TIMEOUT_MS;

    if (remainingMs <= 0) {
      return [];
    }

    let recognition = imageCache.get(cacheKey);
    if (!recognition) {
      recognition = recognizeCrop(imageBuffer, crop);
      imageCache.set(cacheKey, recognition);
    }

    return await withTimeout(recognition, remainingMs);
  } catch {
    return [];
  }
}

/**
 * Reads the small CAGI age box without allowing OCR to invent a value. The
 * shared worker and deadline are intentional: age OCR is optional enrichment
 * and must never extend the request budget.
 */
export async function recognizeDigitsInRegion(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  rect: PixelRect,
  options?: DigitOcrOptions,
  templateReference?: DigitTemplateReference,
): Promise<number | undefined> {
  const result = await recognizeDigitsInRegionDetailed(
    imageBuffer,
    imageWidth,
    imageHeight,
    rect,
    options,
    templateReference,
  );

  return result.value;
}

export async function recognizeDigitsInRegionDetailed(
  imageBuffer: Buffer,
  imageWidth: number,
  imageHeight: number,
  rect: PixelRect,
  options?: DigitOcrOptions,
  templateReference?: DigitTemplateReference,
): Promise<DigitOcrResult> {
  try {
    if (!Buffer.isBuffer(imageBuffer) || imageWidth <= 0 || imageHeight <= 0) {
      return {
        status: 'invalid_input',
        diagnostic: 'Age OCR was skipped because the input image was invalid.',
      };
    }

    const remainingMs = options?.deadlineAt
      ? Math.min(DIGIT_OCR_TOTAL_TIMEOUT_MS, options.deadlineAt - Date.now())
      : DIGIT_OCR_TOTAL_TIMEOUT_MS;
    if (remainingMs <= 0) {
      return {
        status: 'deadline_exhausted',
        diagnostic: 'Age OCR was skipped because the per-student deadline had expired.',
      };
    }

    if (digitWorkerPromise && !digitWorkerReady) {
      return {
        status: 'worker_pending',
        diagnostic: 'Age OCR was skipped because the shared OCR worker was still initializing.',
      };
    }

    const crop = buildPixelCropBounds(imageWidth, imageHeight, rect);
    if (!crop) {
      return {
        status: 'invalid_crop',
        diagnostic: 'Age OCR was skipped because the age-number box was invalid.',
      };
    }

    return await withTimeout(
      recognizeDigitsCropDetailed(imageBuffer, crop, templateReference),
      remainingMs,
    );
  } catch {
    return {
      status: 'timeout_or_error',
      diagnostic: 'Age OCR did not finish within the allowed time.',
    };
  }
}

export function parseAgeOcrText(text: unknown): number | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }

  const normalized = text.replace(/\s/g, '');
  if (!/^\d{1,2}$/.test(normalized)) {
    return undefined;
  }

  const age = Number.parseInt(normalized, 10);
  return Number.isInteger(age) && age >= 1 && age <= 20 ? age : undefined;
}

export function parseTrustedAgeOcrText(text: unknown, confidence: number): number | undefined {
  if (!Number.isFinite(confidence) || confidence < MIN_DIGIT_CONFIDENCE) {
    return undefined;
  }

  return parseAgeOcrText(text);
}

type StrokeReading = NonNullable<DigitReading['perStroke']>[number];

/**
 * Reads the one digit the reader will not speak for.
 *
 * A stroke narrow enough can only be a `1`: see `DIGIT_ONE_MAX_ASPECT`. That
 * is a property of the decimal glyphs, not of any page. But it is also the one
 * place in this file that can put a digit into the draft that no reader ever
 * saw, so it is gated to the case where the shape evidence is unambiguous and
 * the rest of the number is not a guess:
 *
 *  - exactly two shapes, so there is nothing else the narrow one could be part
 *    of, and only one of them is narrow enough to be the `1`
 *  - the narrow shape is thicker than the printed structure this file already
 *    erases by width, so a surviving rule or divider cannot pose as a digit
 *  - the two shapes are about the same height, so a fragment cannot either
 *  - the other shape was read on its own, as a single digit, at or above
 *    `MIN_DIGIT_CONFIDENCE` -- the pair is never two inferences
 *  - the reader did not itself read the narrow shape as something else; a
 *    reading is only supplied where there was none
 *
 * The confidence carried forward is the other digit's own, because that is the
 * only reading involved. Nothing here relaxes `MIN_DIGIT_CONFIDENCE`.
 */
function inferNarrowOne(
  perDigit: DigitReading | undefined,
  workWidth: number,
): { value: number; text: string; read: string; confidence: number } | undefined {
  const strokes = perDigit?.perStroke;
  if (!strokes || strokes.length !== 2) {
    return undefined;
  }

  const minPenWidth = workWidth * DIGIT_RULE_COLUMN_WIDTH_FRACTION;
  const narrowFirst = isNarrowEnoughForOne(strokes[0], minPenWidth);
  const narrowSecond = isNarrowEnoughForOne(strokes[1], minPenWidth);
  if (narrowFirst === narrowSecond) {
    return undefined;
  }

  const narrow = narrowFirst ? strokes[0] : strokes[1];
  const other = narrowFirst ? strokes[1] : strokes[0];

  const narrowText = digitsOf(narrow.text);
  if (narrowText !== '' && narrowText !== '1') {
    return undefined;
  }

  const shorter = Math.min(narrow.height, other.height);
  const taller = Math.max(narrow.height, other.height);
  if (taller <= 0 || shorter < taller * DIGIT_PAIR_HEIGHT_MATCH) {
    return undefined;
  }

  const otherText = digitsOf(other.text);
  if (otherText.length !== 1) {
    return undefined;
  }
  if (!Number.isFinite(other.confidence) || other.confidence < MIN_DIGIT_CONFIDENCE) {
    return undefined;
  }

  const text = narrowFirst ? `1${otherText}` : `${otherText}1`;
  const value = parseAgeOcrText(text);
  return value === undefined
    ? undefined
    : { value, text, read: otherText, confidence: other.confidence };
}

function isNarrowEnoughForOne(stroke: StrokeReading, minPenWidth: number): boolean {
  return stroke.width > minPenWidth && stroke.width <= stroke.height * DIGIT_ONE_MAX_ASPECT;
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/**
 * Whether a reading may be missing a digit that was thrown away with the
 * printed structure.
 *
 * Handwriting that touches the box outline is one connected shape with it, and
 * dropping that shape drops the digit too. A reading of a single digit taken
 * from what is left cannot be told apart from a two-digit age whose other digit
 * went with the frame, so it is shown blank for a reviewer instead of being
 * written into the draft. A two-digit reading is unaffected, and so is every
 * box the frame filter did not touch -- including one where it emptied the box
 * and the raw ink was read instead, because there nothing was thrown away.
 */
function isPartialReading(shape: DigitShape, text: string): boolean {
  return shape.framesRemoved > 0 && !shape.readRawInk && digitsOf(text).length < 2;
}

async function recognizeCrop(
  imageBuffer: Buffer,
  crop: { left: number; top: number; width: number; height: number },
): Promise<OcrTextLine[]> {
  try {
    const croppedBuffer = await sharp(imageBuffer)
      .rotate()
      .extract(crop)
      .flatten({ background: '#ffffff' })
      .grayscale()
      .png()
      .toBuffer();

    const worker = await getWorker();
    const result = await worker.recognize(croppedBuffer, {}, { text: true, blocks: true });

    const lines = result.data.lines
      .map((line) => {
        const height = line.bbox.y1 - line.bbox.y0;
        return {
          y: crop.top + (line.bbox.y0 + line.bbox.y1) / 2,
          confidence: line.confidence,
          height,
        };
      })
      .filter((line) => line.confidence >= MIN_CONFIDENCE && line.height >= MIN_LINE_HEIGHT)
      .sort((a, b) => a.y - b.y);

    return groupNearbyLines(lines);
  } catch {
    return [];
  }
}

/**
 * Reads the age box with two independent readers and only believes them when
 * they say the same thing.
 *
 * Reading the whole box as one word is what the deployed build already did; it
 * gets the digits right far more often than it is confident about them.
 * Reading each stroke on its own is confident -- but on a small crop it can be
 * confidently wrong: a handwritten "13" came back as "12" with confidence 92 on
 * the synthetic bench. Neither reading is trusted alone. `MIN_DIGIT_CONFIDENCE`
 * still has to be cleared, and now the two readers have to agree on the number
 * as well, which is a stricter gate than the deployed one, not a looser one.
 */
async function recognizeDigitsCropDetailed(
  imageBuffer: Buffer,
  crop: { left: number; top: number; width: number; height: number },
  templateReference?: DigitTemplateReference,
): Promise<DigitOcrResult> {
  try {
    const { found, shape } = await buildDigitStrokes(imageBuffer, crop, templateReference);
    if (!found) {
      return {
        status: 'no_handwriting_found',
        diagnostic: `Age OCR found no handwriting in the age box once the printed rules were removed. ${describeShape(shape)}`,
      };
    }

    const { wholeBox, perDigit } = await readDigitStrokes(found);
    const evidence = `${describeReadings(wholeBox, perDigit)} ${describeShape(shape)}`;
    const wholeBoxValue = parseAgeOcrText(wholeBox.text);
    const perDigitValue = perDigit ? parseAgeOcrText(perDigit.text) : undefined;

    // One shape the reader will not speak for, narrow enough that no digit but
    // `1` can be drawn that way, beside one it read confidently. This is
    // checked before the reader gates because those gates ask both readers for
    // a whole number, and the whole-box reader has nothing to say about a box
    // it could only half read.
    const narrowOne = inferNarrowOne(perDigit, shape.workWidth);
    if (narrowOne !== undefined) {
      // Never overrule a reading this pipeline would have trusted on its own.
      // A number the whole-box reader produced below the threshold is not one
      // of those -- the rest of this function already refuses to act on it.
      const contradicted = wholeBoxValue !== undefined
        && wholeBox.confidence >= MIN_DIGIT_CONFIDENCE
        && wholeBoxValue !== narrowOne.value;
      if (!contradicted) {
        return {
          value: narrowOne.value,
          status: 'accepted',
          diagnostic: `Age OCR accepted ${narrowOne.value} [gate=narrow-stroke-is-one]: the wide shape read as ${narrowOne.read} at confidence ${Math.round(narrowOne.confidence)} of ${MIN_DIGIT_CONFIDENCE} needed, and the other is too narrow for any digit but 1. ${evidence}`,
        };
      }
    }

    if (perDigit && wholeBoxValue !== undefined && perDigitValue !== undefined) {
      if (wholeBoxValue !== perDigitValue) {
        return {
          status: 'parse_or_confidence_rejected',
          diagnostic: `Age OCR rejected [gate=readers-disagreed]: the two readings were different numbers. ${evidence}`,
        };
      }
      if (isPartialReading(shape, wholeBox.text)) {
        return {
          status: 'parse_or_confidence_rejected',
          diagnostic: `Age OCR rejected [gate=one-digit-after-frame-removal]: both readings said ${wholeBoxValue}, but printed structure was removed from the box and a single digit cannot be told apart from the other one having gone with it. ${evidence}`,
        };
      }
      const confidence = Math.max(wholeBox.confidence, perDigit.confidence);
      const value = parseTrustedAgeOcrText(wholeBox.text, confidence);
      if (value !== undefined) {
        return {
          value,
          status: 'accepted',
          diagnostic: `Age OCR accepted ${value} [gate=readers-agreed]: best confidence ${Math.round(confidence)} of ${MIN_DIGIT_CONFIDENCE} needed. ${evidence}`,
        };
      }
      return {
        status: 'parse_or_confidence_rejected',
        diagnostic: `Age OCR rejected [gate=agreed-below-confidence]: both readings said ${wholeBoxValue} but the best confidence was ${Math.round(confidence)} of ${MIN_DIGIT_CONFIDENCE} needed. ${evidence}`,
      };
    }

    // Only one reader produced digits -- fall back to the single-reading gate.
    if (wholeBoxValue !== undefined) {
      if (isPartialReading(shape, wholeBox.text)) {
        return {
          status: 'parse_or_confidence_rejected',
          diagnostic: `Age OCR rejected [gate=one-digit-after-frame-removal]: the only number read was ${wholeBoxValue}, but printed structure was removed from the box and a single digit cannot be told apart from the other one having gone with it. ${evidence}`,
        };
      }
      const value = parseTrustedAgeOcrText(wholeBox.text, wholeBox.confidence);
      if (value !== undefined) {
        return {
          value,
          status: 'accepted',
          diagnostic: `Age OCR accepted ${value} [gate=whole-box-only]: confidence ${Math.round(wholeBox.confidence)} of ${MIN_DIGIT_CONFIDENCE} needed. ${evidence}`,
        };
      }
      return {
        status: 'parse_or_confidence_rejected',
        diagnostic: `Age OCR rejected [gate=whole-box-below-confidence]: the only number read was ${wholeBoxValue} at confidence ${Math.round(wholeBox.confidence)} of ${MIN_DIGIT_CONFIDENCE} needed. ${evidence}`,
      };
    }

    if (perDigitValue !== undefined) {
      return {
        status: 'parse_or_confidence_rejected',
        diagnostic: `Age OCR rejected [gate=whole-box-unreadable]: only the per-digit reading was a number in range. ${evidence}`,
      };
    }

    return {
      status: 'parse_or_confidence_rejected',
      diagnostic: `Age OCR rejected [gate=no-number-read]: neither reading was a 1-20 number. ${evidence}`,
    };
  } catch {
    return {
      status: 'timeout_or_error',
      diagnostic: 'Age OCR failed while processing the digit box.',
    };
  }
}

interface DigitShape {
  cropWidth: number;
  cropHeight: number;
  workWidth: number;
  workHeight: number;
  template: 0 | 1;
  otsu: number;
  inkPermille: number;
  /** Left to right, in the same order the per-digit reader reads them. */
  strokes: Array<{ width: number; height: number }>;
  /** Printed lines fitted across the box, and how many were its own walls. */
  rules: number;
  walls: number;
  /** The closest the search came when it found nothing. */
  bestRun: number;
  minRun: number;
  bestSlant: number;
  maxSlant: number;
  /** Shapes dropped for covering the whole width of the field. */
  framesRemoved: number;
  /** Set when frame removal emptied the box and the raw ink was read instead. */
  readRawInk: boolean;
}

/**
 * The geometry the readers were given, as numbers only. This is what makes a
 * rejection on a scan nobody can share still diagnosable: whether the crop was
 * the expected size, whether the histogram split somewhere sane, and whether
 * the writing came apart into one shape per digit.
 */
function describeShape(shape: DigitShape): string {
  const strokes = shape.strokes
    .slice(0, 4)
    .map((stroke) => `${stroke.width}x${stroke.height}`)
    .join(',');
  const extra = shape.strokes.length > 4 ? `+${shape.strokes.length - 4}` : '';

  const frames = shape.framesRemoved > 0 ? ` frames-removed=${shape.framesRemoved}` : '';
  const raw = shape.readRawInk ? ' read=raw-ink' : '';
  // Whether the box's own walls were found at all. Without this a stroke still
  // reaching the full height cannot be told apart from a wall that was never
  // detected, which is the next question either outcome raises.
  // When nothing was found, how close the best candidate came and at what
  // slope. That separates "the rule is there and the search cannot reach it"
  // from "there is no rule and the stroke really is that tall".
  const miss = shape.rules === 0
    ? ` best=${shape.bestRun}/${shape.minRun}@s=${shape.bestSlant}/${shape.maxSlant}`
    : '';
  const lines = ` rules=${shape.rules}(walls=${shape.walls}${miss})`;

  return `[crop=${shape.cropWidth}x${shape.cropHeight} work=${shape.workWidth}x${shape.workHeight}`
    + ` tmpl=${shape.template} otsu=${shape.otsu} ink=${shape.inkPermille}/1000`
    + ` strokes=${shape.strokes.length}(${strokes}${extra})${lines}${frames}${raw}]`;
}

/**
 * What the two readers returned. Only digits ever leave this function: the text
 * is stripped to `0-9` before it is written anywhere, so nothing else from a
 * scanned page can reach a log or a review screen through this string.
 */
function describeReadings(wholeBox: DigitReading, perDigit?: DigitReading): string {
  const perDigitPart = perDigit
    ? `per-digit=${describeReading(perDigit)}`
    : 'per-digit=skipped';

  return `[whole-box=${describeReading(wholeBox)} ${perDigitPart}]`;
}

function describeReading(reading: DigitReading): string {
  const digits = reading.text.replace(/\D/g, '');
  const dropped = reading.text.length - digits.length;
  const shown = digits.slice(0, 8);
  const length = digits.length > shown.length ? ` len=${digits.length}` : '';
  const nonDigits = dropped > 0 ? ` nondigits=${dropped}` : '';
  // Each shape paired with what it alone was read as. Without the pairing a
  // confidence of `(0,92)` says one digit was silent but not which shape it
  // came from, so "is the silent digit always the narrow one?" cannot be
  // answered from a diagnostic on a scan nobody can share.
  const perStroke = reading.perStroke && reading.perStroke.length > 0
    ? ` (${reading.perStroke
      .slice(0, 4)
      .map((part) => `${part.width}x${part.height}="${part.text.replace(/\D/g, '').slice(0, 2)}"c${Math.round(part.confidence)}`)
      .join(' ')})`
    : '';

  return `"${shown}" conf=${Math.round(reading.confidence)}${perStroke}${length}${nonDigits}`;
}

interface DigitReading {
  text: string;
  confidence: number;
  /** Each separately-read shape, left to right, with its own reading. */
  perStroke?: Array<{ width: number; height: number; text: string; confidence: number }>;
}

/**
 * Runs both readers on one shared worker. The calls are serialised because the
 * page segmentation mode is worker state: two overlapping requests setting it
 * would otherwise recognise each other's images in the wrong mode.
 */
function readDigitStrokes(
  strokes: DigitStrokes,
): Promise<{ wholeBox: DigitReading; perDigit?: DigitReading }> {
  return runDigitOcrExclusively(async () => {
    const worker = await getDigitWorker();
    const wholeBoxImage = await renderStrokesForOcr(strokes.mask, strokes.strokes);
    const wholeBox = await readWith(worker, wholeBoxImage, PSM.SINGLE_WORD);

    // One shape per digit is the only case the per-digit reader can speak
    // about. Anything else -- two digits written into each other, a stroke that
    // broke in half -- is left to the whole-box reading alone.
    if (strokes.strokes.length < 1 || strokes.strokes.length > 2) {
      return { wholeBox };
    }

    const ordered = [...strokes.strokes].sort((first, second) => first.left - second.left);
    let text = '';
    let confidence = 100;
    const perStroke: NonNullable<DigitReading['perStroke']> = [];
    for (const stroke of ordered) {
      const image = await renderStrokesForOcr(strokes.mask, [stroke]);
      const reading = await readWith(worker, image, PSM.SINGLE_CHAR);
      text += reading.text;
      confidence = Math.min(confidence, reading.confidence);
      perStroke.push({
        width: stroke.right - stroke.left + 1,
        height: stroke.bottom - stroke.top + 1,
        text: reading.text,
        confidence: reading.confidence,
      });
    }

    return { wholeBox, perDigit: { text, confidence, perStroke } };
  });
}

async function readWith(worker: Worker, image: Buffer, pageSegMode: PSM): Promise<DigitReading> {
  await worker.setParameters({ tessedit_pageseg_mode: pageSegMode });
  const result = await worker.recognize(image, {}, { text: true });
  return {
    text: typeof result.data.text === 'string' ? result.data.text.replace(/\s/g, '') : '',
    confidence: Number.isFinite(result.data.confidence) ? result.data.confidence : 0,
  };
}

function runDigitOcrExclusively<T>(task: () => Promise<T>): Promise<T> {
  const result = digitOcrQueue.then(task, task);
  digitOcrQueue = result.then(() => undefined, () => undefined);
  return result;
}

interface DigitStrokes {
  mask: InkMask;
  strokes: InkStroke[];
}

/**
 * Turns the raw age crop into the strokes a reader may look at, or `undefined`
 * when the box holds no handwriting.
 *
 * Two failures were measured on real scans (Task/AGE_OCR_PREPROCESSING_2026-08-20.md):
 * the printed rule under the digits stayed inside the crop, and a fixed
 * `threshold(190)` broke thin strokes apart. Both are addressed here -- printed
 * structure is erased by shape (sloping rules, thin full-height columns) and the
 * black/white split is taken from the crop's own histogram.
 *
 * Instrumenting all six real pages then showed a shape as wide as the entire
 * working image on four of them, and on one page the whole image was a single
 * shape. That cannot be a handwritten digit: two digits sit side by side in this
 * box, so neither of them -- nor both written into each other -- reaches from
 * one edge of the field to the other. Such a shape is dropped here, after the
 * rules that hold it together have been cut, which is what releases a digit that
 * was touching the box outline.
 *
 * Nothing in this path relaxes `MIN_DIGIT_CONFIDENCE`; a cleaner image is the
 * only way a value gets through.
 */
async function buildDigitStrokes(
  imageBuffer: Buffer,
  crop: { left: number; top: number; width: number; height: number },
  templateReference?: DigitTemplateReference,
): Promise<{ found?: DigitStrokes; shape: DigitShape }> {
  const upscale = Math.max(
    DIGIT_MIN_UPSCALE,
    DIGIT_MIN_WORKING_WIDTH / crop.width,
    DIGIT_MIN_WORKING_HEIGHT / crop.height,
  );
  const width = Math.round(crop.width * upscale);
  const height = Math.round(crop.height * upscale);

  const { data: croppedPixels } = await sharp(imageBuffer)
    .rotate()
    .extract(crop)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize({ width, height, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const inkPixels = templateReference
    ? await subtractTemplateDigits(croppedPixels, width, height, templateReference)
    : croppedPixels;

  const { mask, threshold, inkCount } = buildInkMask(inkPixels, width, height);
  const shape: DigitShape = {
    cropWidth: crop.width,
    cropHeight: crop.height,
    workWidth: width,
    workHeight: height,
    template: templateReference ? 1 : 0,
    otsu: threshold,
    inkPermille: Math.round((inkCount / mask.data.length) * 1000),
    strokes: [],
    rules: 0,
    walls: 0,
    bestRun: 0,
    minRun: 0,
    bestSlant: 0,
    maxSlant: 0,
    framesRemoved: 0,
    readRawInk: false,
  };

  if (inkCount < mask.data.length * DIGIT_MIN_INK_FRACTION) {
    return { shape };
  }

  const rawInk = mask.data.slice();
  const erased = eraseHorizontalRules(mask);
  Object.assign(shape, erased);
  const strokes = keepDigitStrokes(mask);
  if (strokes.length === 0) {
    return { shape };
  }

  const maxStrokeWidth = mask.width * DIGIT_MAX_STROKE_WIDTH_FRACTION;
  const digits: InkStroke[] = [];
  const frames: InkStroke[] = [];
  for (const stroke of strokes) {
    (stroke.right - stroke.left + 1 < maxStrokeWidth ? digits : frames).push(stroke);
  }
  shape.framesRemoved = frames.length;

  if (digits.length > 0) {
    for (const stroke of frames) {
      for (const index of stroke.pixels) {
        mask.data[index] = 0;
      }
    }
    return { found: { mask, strokes: digits }, shape: describeStrokes(shape, digits) };
  }

  // Every shape in the box covered the whole field, so there is nothing left to
  // hand over. Removing printed structure must not turn a box that produced a
  // reading into one that produces none, so the ink is read as it stood before
  // any of it was erased.
  shape.readRawInk = true;
  mask.data.set(rawInk);
  const rawStrokes = keepDigitStrokes(mask);
  if (rawStrokes.length === 0) {
    return { shape };
  }

  return { found: { mask, strokes: rawStrokes }, shape: describeStrokes(shape, rawStrokes) };
}

/**
 * Records the shapes actually handed to the readers, left to right, which is
 * the order the per-digit reader reads them in -- so a stroke in the diagnostic
 * lines up with the confidence its own reading got.
 */
function describeStrokes(shape: DigitShape, strokes: InkStroke[]): DigitShape {
  shape.strokes = [...strokes]
    .sort((first, second) => first.left - second.left)
    .map((stroke) => ({
      width: stroke.right - stroke.left + 1,
      height: stroke.bottom - stroke.top + 1,
    }));
  return shape;
}

async function subtractTemplateDigits(
  actualPixels: Buffer,
  targetWidth: number,
  targetHeight: number,
  templateReference: DigitTemplateReference,
): Promise<Buffer> {
  const templateCrop = buildPixelCropBounds(
    templateReference.image.width,
    templateReference.image.height,
    templateReference.rect,
  );
  if (!templateCrop) {
    return actualPixels;
  }

  const { data: blankPixels } = await sharp(templateReference.image.pixels, {
    raw: {
      width: templateReference.image.width,
      height: templateReference.image.height,
      channels: 1,
    },
  })
    .extract(templateCrop)
    .resize({ width: targetWidth, height: targetHeight, fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const brightnessOffset = percentile(blankPixels, 0.82) - percentile(actualPixels, 0.82);
  const output = Buffer.alloc(actualPixels.length, 255);

  for (let index = 0; index < actualPixels.length; index++) {
    const normalizedActual = clamp(actualPixels[index] + brightnessOffset, 0, 255);
    // The blank form removes the box outline and its centre divider. Keep only
    // strokes that are darker than the printed template at the matching
    // position. Where the two are a pixel or two out of register the printed
    // rule survives as added ink -- `eraseHorizontalRules` and
    // `keepDigitStrokes` are what finally remove it.
    const addedInk = blankPixels[index] - normalizedActual;
    if (addedInk > DIGIT_TEMPLATE_INK_FLOOR) {
      output[index] = clamp(255 - (addedInk - DIGIT_TEMPLATE_INK_FLOOR) * DIGIT_TEMPLATE_INK_GAIN, 0, 255);
    }
  }

  return output;
}

interface InkMask {
  data: Uint8Array;
  width: number;
  height: number;
}

interface InkStroke {
  left: number;
  right: number;
  top: number;
  bottom: number;
  pixels: number[];
}

/**
 * Splits the crop into ink and paper at a level taken from its own histogram
 * (Otsu). A fixed cut cannot serve both a dark ballpoint entry and a faint
 * pencil one; this is what stops thin strokes from dissolving into specks.
 * The threshold and the ink count come back with the mask so the caller can
 * report them when nothing readable is found.
 */
function buildInkMask(
  pixels: Buffer,
  width: number,
  height: number,
): { mask: InkMask; threshold: number; inkCount: number } {
  const threshold = otsuThreshold(pixels);
  const data = new Uint8Array(width * height);
  let inkCount = 0;

  for (let index = 0; index < data.length; index++) {
    if (pixels[index] <= threshold) {
      data[index] = 1;
      inkCount++;
    }
  }

  return { mask: { data, width, height }, threshold, inkCount };
}

function otsuThreshold(pixels: Buffer): number {
  const histogram = new Uint32Array(256);
  for (let index = 0; index < pixels.length; index++) {
    histogram[pixels[index]]++;
  }

  let weightedTotal = 0;
  for (let level = 0; level < 256; level++) {
    weightedTotal += level * histogram[level];
  }

  let darkWeight = 0;
  let darkWeightedSum = 0;
  let bestLevel = 0;
  let bestVariance = -1;

  for (let level = 0; level < 256; level++) {
    darkWeight += histogram[level];
    if (darkWeight === 0) {
      continue;
    }
    const lightWeight = pixels.length - darkWeight;
    if (lightWeight === 0) {
      break;
    }
    darkWeightedSum += level * histogram[level];
    const darkMean = darkWeightedSum / darkWeight;
    const lightMean = (weightedTotal - darkWeightedSum) / lightWeight;
    const variance = darkWeight * lightWeight * (darkMean - lightMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestLevel = level;
    }
  }

  return bestLevel;
}

/**
 * Erases the printed rules that run through the age box. A rule is a dark line
 * covering most of the box width, which no handwritten stroke does -- but on a
 * scan it is a *sloping* line, and the crop is enlarged about six times before
 * this runs, so it never stays inside one row. Looking for a run within a
 * single row therefore found nothing and the whole box outline survived as one
 * connected shape spanning the working image, with the handwriting that touched
 * it fused in. Lines are fitted with a slope instead, over the small range of
 * skew a scanned page can have.
 *
 * Only thin ink columns are erased where the line passes. Where a digit crosses
 * a rule the ink column runs the height of the stroke, so a "4" standing on the
 * line keeps its stem and is released as its own shape once the rule is gone.
 *
 * That protection is right for a rule inside the field and wrong for the box's
 * own top and bottom walls, where it leaves a stub of printed line standing at
 * the digit's columns all the way to the edge of the crop. Measured on real
 * scans, every stroke that reached the full height of the working image was
 * read as nothing, and the one that did not reach it read at confidence 90 --
 * the reader was being handed a digit welded to two rails. A wall is therefore
 * cleared out to the edge regardless of what crosses it; see `classifyRuleLine`.
 */
function eraseHorizontalRules(mask: InkMask): RuleReport {
  const { width, height } = mask;
  const minRun = Math.max(8, Math.round(width * DIGIT_RULE_RUN_FRACTION));
  const maxSlant = Math.max(1, Math.round(height * DIGIT_RULE_MAX_SLANT_FRACTION));
  const maxThickness = Math.max(2, Math.round(height * DIGIT_RULE_MAX_THICKNESS_FRACTION));
  const columns = measureInkColumns(mask);
  const search = findRuleLines(mask, minRun, maxSlant, maxThickness);
  let walls = 0;

  for (const line of search.lines) {
    if (eraseRuleLine(mask, columns, line, maxThickness) !== 'crossing') {
      walls++;
    }
  }

  return {
    rules: search.lines.length,
    walls,
    bestRun: search.bestRun,
    minRun,
    bestSlant: search.bestSlant,
    maxSlant,
  };
}

/**
 * What the rule search saw. The near-miss numbers matter only when nothing was
 * found: a stroke still reaching the full height of the working image with no
 * rule detected is either a rule the search cannot reach -- too broken for the
 * run threshold, or sloping past the slant bound -- or handwriting that genuinely
 * overshoots the crop, and those want opposite fixes.
 */
interface RuleReport {
  rules: number;
  walls: number;
  bestRun: number;
  minRun: number;
  bestSlant: number;
  maxSlant: number;
}

interface RuleLine {
  /** Row the line starts on, at x = 0. */
  top: number;
  /** Total rows the line drifts across the full width; may be negative. */
  slant: number;
  /** Longest unbroken stretch of the line that was actually inked. */
  run: number;
}

/**
 * The unbroken vertical stretch of ink each pixel belongs to. A printed rule is
 * a short stretch; a digit stroke crossing it is a long one.
 */
function measureInkColumns(mask: InkMask): { top: Int32Array; length: Int32Array } {
  const { data, width, height } = mask;
  const top = new Int32Array(data.length);
  const length = new Int32Array(data.length);

  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      if (!data[y * width + x]) {
        y++;
        continue;
      }
      let end = y;
      while (end + 1 < height && data[(end + 1) * width + x]) {
        end++;
      }
      for (let row = y; row <= end; row++) {
        top[row * width + x] = y;
        length[row * width + x] = end - y + 1;
      }
      y = end + 1;
    }
  }

  return { top, length };
}

interface RuleSearch {
  lines: RuleLine[];
  /** Longest stretch any candidate line managed, accepted or not. */
  bestRun: number;
  bestSlant: number;
}

function findRuleLines(mask: InkMask, minRun: number, maxSlant: number, maxThickness: number): RuleSearch {
  const { data, width, height } = mask;
  const found: RuleLine[] = [];
  const lastColumn = Math.max(1, width - 1);
  let bestRun = 0;
  let bestSlant = 0;

  for (let slant = -maxSlant; slant <= maxSlant; slant++) {
    for (let top = 0; top < height; top++) {
      let run = 0;
      let longestRun = 0;
      for (let x = 0; x < width; x++) {
        const y = top + Math.round((slant * x) / lastColumn);
        // A single row of tolerance absorbs the rounding of the fitted line
        // against where the rule's ink actually landed.
        const inked = y >= 0
          && y < height
          && (data[y * width + x]
            || (y > 0 && data[(y - 1) * width + x])
            || (y + 1 < height && data[(y + 1) * width + x]));
        run = inked ? run + 1 : 0;
        if (run > longestRun) {
          longestRun = run;
        }
      }
      if (longestRun > bestRun) {
        bestRun = longestRun;
        bestSlant = slant;
      }
      if (longestRun >= minRun) {
        found.push({ top, slant, run: longestRun });
      }
    }
  }

  // Neighbouring offsets and slopes all describe the same rule. Keep the
  // best-covered one of each group so a thick rule is erased once.
  found.sort((first, second) => second.run - first.run);
  const distinct: RuleLine[] = [];
  for (const line of found) {
    const middle = line.top + line.slant / 2;
    const overlaps = distinct.some(
      (kept) => Math.abs(kept.top + kept.slant / 2 - middle) <= maxThickness,
    );
    if (!overlaps) {
      distinct.push(line);
    }
  }

  return { lines: distinct, bestRun, bestSlant };
}

/**
 * Whether a rule is one of the box's own walls rather than a line the digits
 * are written across. A wall's ink reaches the edge of the crop; a rule the
 * writing sits on has paper on both sides of it.
 *
 * The distinction decides whether the crossing protection applies. It must
 * apply to a rule inside the field, or cutting it would take a digit's stem
 * with it. It must *not* apply to a wall: there is no handwriting beyond the
 * edge of the field to protect, so the protection only preserves a stub of
 * printed line at the digit's own columns -- and a stub reaching the edge of
 * the crop is what welds a rail onto the glyph handed to the reader.
 */
function classifyRuleLine(
  mask: InkMask,
  line: RuleLine,
  maxThickness: number,
): 'top-wall' | 'bottom-wall' | 'crossing' {
  const { data, width, height } = mask;
  const lastColumn = Math.max(1, width - 1);
  let above = 0;
  let band = 0;
  let below = 0;

  for (let x = 0; x < width; x++) {
    const centre = line.top + Math.round((line.slant * x) / lastColumn);
    for (let y = 0; y < height; y++) {
      if (!data[y * width + x]) {
        continue;
      }
      // The line's own ink is as deep as a rule may be, not one row. Counting
      // it as ink beyond the line is what made a wall look like a crossing.
      if (y < centre - maxThickness) {
        above++;
      } else if (y > centre + maxThickness) {
        below++;
      } else {
        band++;
      }
    }
  }

  const total = above + band + below;
  if (total === 0) {
    return 'crossing';
  }

  // A wall sits at the edge of the field with the writing all on one side of
  // it. A rule the digits are written across has ink on both sides, and the
  // crossing protection has to hold there or cutting the rule would take a
  // stem with it.
  const outside = total * DIGIT_WALL_OUTSIDE_INK_FRACTION;
  const middle = line.top + line.slant / 2;
  if (middle <= height / 4 && above <= outside) {
    return 'top-wall';
  }
  if (middle >= (height * 3) / 4 && below <= outside) {
    return 'bottom-wall';
  }
  return 'crossing';
}

function eraseRuleLine(
  mask: InkMask,
  columns: { top: Int32Array; length: Int32Array },
  line: RuleLine,
  maxThickness: number,
): 'top-wall' | 'bottom-wall' | 'crossing' {
  const { data, width, height } = mask;
  const lastColumn = Math.max(1, width - 1);
  const role = classifyRuleLine(mask, line, maxThickness);

  for (let x = 0; x < width; x++) {
    const centre = line.top + Math.round((line.slant * x) / lastColumn);

    // A wall bounds the field. Everything between it and the edge of the crop
    // is outside the box, so it goes whether or not a stroke crosses -- which
    // is what frees the digit's top or foot from the printed line it was
    // touching, and lets its own extent decide the shape handed to the reader.
    if (role === 'top-wall') {
      // Down to the far side of the wall's own ink, but never deeper than a
      // rule can be -- so where a digit is fused to the wall it gives up a
      // rule's thickness off its head instead of the whole stroke.
      let last = Math.min(centre + 1, height - 1);
      const limit = Math.min(centre + maxThickness, height - 1);
      while (last < limit && data[(last + 1) * width + x]) {
        last++;
      }
      for (let row = 0; row <= last; row++) {
        data[row * width + x] = 0;
      }
    } else if (role === 'bottom-wall') {
      let first = Math.max(centre - 1, 0);
      const limit = Math.max(centre - maxThickness, 0);
      while (first > limit && data[(first - 1) * width + x]) {
        first--;
      }
      for (let row = first; row < height; row++) {
        data[row * width + x] = 0;
      }
    }

    for (let offset = -1; offset <= 1; offset++) {
      const y = centre + offset;
      if (y < 0 || y >= height) {
        continue;
      }
      const index = y * width + x;
      if (!data[index] || columns.length[index] > maxThickness) {
        continue;
      }
      const first = columns.top[index];
      const last = first + columns.length[index] - 1;
      for (let row = first; row <= last; row++) {
        data[row * width + x] = 0;
      }
    }
  }

  return role;
}

/**
 * Keeps only the connected shapes that can be a handwritten digit and erases
 * the rest: the dashes left by the box's centre divider, scanner speckle, and
 * the thin full-height columns of the box outline itself.
 */
function keepDigitStrokes(mask: InkMask): InkStroke[] {
  const minStrokeHeight = mask.height * DIGIT_MIN_STROKE_HEIGHT_FRACTION;
  const ruleColumnHeight = mask.height * DIGIT_RULE_COLUMN_HEIGHT_FRACTION;
  const ruleColumnWidth = Math.max(2, mask.width * DIGIT_RULE_COLUMN_WIDTH_FRACTION);
  const kept: InkStroke[] = [];

  for (const stroke of findInkStrokes(mask)) {
    const strokeWidth = stroke.right - stroke.left + 1;
    const strokeHeight = stroke.bottom - stroke.top + 1;
    const isSpeck = strokeHeight < minStrokeHeight;
    const isPrintedColumn = strokeHeight >= ruleColumnHeight && strokeWidth <= ruleColumnWidth;
    if (isSpeck || isPrintedColumn) {
      for (const index of stroke.pixels) {
        mask.data[index] = 0;
      }
      continue;
    }
    kept.push(stroke);
  }

  return kept;
}

function findInkStrokes(mask: InkMask): InkStroke[] {
  const { data, width, height } = mask;
  const visited = new Uint8Array(data.length);
  const strokes: InkStroke[] = [];
  const stack: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || visited[start]) {
      continue;
    }
    visited[start] = 1;
    stack.length = 0;
    stack.push(start);
    const stroke: InkStroke = { left: width, right: -1, top: height, bottom: -1, pixels: [] };

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      stroke.pixels.push(index);
      if (x < stroke.left) stroke.left = x;
      if (x > stroke.right) stroke.right = x;
      if (y < stroke.top) stroke.top = y;
      if (y > stroke.bottom) stroke.bottom = y;

      for (let dy = -1; dy <= 1; dy++) {
        const row = y + dy;
        if (row < 0 || row >= height) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const column = x + dx;
          if (column < 0 || column >= width) {
            continue;
          }
          const neighbour = row * width + column;
          if (data[neighbour] && !visited[neighbour]) {
            visited[neighbour] = 1;
            stack.push(neighbour);
          }
        }
      }
    }

    strokes.push(stroke);
  }

  return strokes;
}

/**
 * Re-frames the given strokes on their own canvas: only those strokes are
 * painted, so a neighbouring digit whose bounding box overlaps cannot leak in,
 * and the result is scaled to a fixed stroke height inside a white border. The
 * deployed image handed over glyphs touching all four edges.
 */
function renderStrokesForOcr(mask: InkMask, strokes: InkStroke[]): Promise<Buffer> {
  const left = Math.min(...strokes.map((stroke) => stroke.left));
  const right = Math.max(...strokes.map((stroke) => stroke.right));
  const top = Math.min(...strokes.map((stroke) => stroke.top));
  const bottom = Math.max(...strokes.map((stroke) => stroke.bottom));
  const width = right - left + 1;
  const height = bottom - top + 1;
  const scale = DIGIT_OCR_STROKE_HEIGHT / height;
  const padding = Math.round(DIGIT_OCR_STROKE_HEIGHT * DIGIT_OCR_PADDING_RATIO);

  const pixels = Buffer.alloc(mask.data.length, 255);
  for (const stroke of strokes) {
    for (const index of stroke.pixels) {
      pixels[index] = 0;
    }
  }

  return sharp(pixels, { raw: { width: mask.width, height: mask.height, channels: 1 } })
    .extract({ left, top, width, height })
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: DIGIT_OCR_STROKE_HEIGHT,
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: '#ffffff',
    })
    .withMetadata({ density: DIGIT_OCR_DPI })
    .png()
    .toBuffer();
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('kor', OEM.DEFAULT, { cachePath: OCR_CACHE_PATH })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          preserve_interword_spaces: '1',
        });
        workerReady = true;
        return worker;
      })
      .catch((error) => {
        workerPromise = null;
        throw error;
      });
  }

  return workerPromise;
}

function buildCropBounds(
  imageWidth: number,
  imageHeight: number,
  searchTop: number,
  searchBottom: number,
  xLeft: number,
  xRight: number,
): { left: number; top: number; width: number; height: number } | null {
  const left = clamp(Math.floor(xLeft), 0, imageWidth - 1);
  const top = clamp(Math.floor(searchTop), 0, imageHeight - 1);
  const right = clamp(Math.ceil(xRight), left + 1, imageWidth);
  const bottom = clamp(Math.ceil(searchBottom), top + 1, imageHeight);
  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { left, top, width, height };
}

function getDigitWorker(): Promise<Worker> {
  if (!digitWorkerPromise) {
    digitWorkerPromise = createWorker('eng', OEM.DEFAULT, {
      cachePath: DIGIT_OCR_CACHE_PATH,
      langPath: DIGIT_OCR_LANG_PATH,
      gzip: false,
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: PSM.SINGLE_WORD,
          preserve_interword_spaces: '0',
          // The crop carries no resolution of its own, so tesseract guessed one
          // ("Invalid resolution 25 dpi. Using 70 instead.") and scaled against
          // it. `renderStrokesForOcr` stamps the same value on the image.
          user_defined_dpi: String(DIGIT_OCR_DPI),
        });
        digitWorkerReady = true;
        return worker;
      })
      .catch((error) => {
        digitWorkerPromise = null;
        throw error;
      });
  }

  return digitWorkerPromise;
}

function buildPixelCropBounds(
  imageWidth: number,
  imageHeight: number,
  rect: PixelRect,
): { left: number; top: number; width: number; height: number } | null {
  const left = clamp(Math.floor(rect.left), 0, imageWidth - 1);
  const top = clamp(Math.floor(rect.top), 0, imageHeight - 1);
  const right = clamp(Math.ceil(rect.right), left + 1, imageWidth);
  const bottom = clamp(Math.ceil(rect.bottom), top + 1, imageHeight);
  const width = right - left;
  const height = bottom - top;

  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

function groupNearbyLines(lines: Array<OcrTextLine & { height: number }>): OcrTextLine[] {
  const grouped: OcrTextLine[] = [];
  let current: Array<OcrTextLine & { height: number }> = [];

  for (const line of lines) {
    const previous = current[current.length - 1];
    if (!previous || Math.abs(line.y - previous.y) <= GROUP_DISTANCE_PX) {
      current.push(line);
      continue;
    }

    grouped.push(toWeightedLine(current));
    current = [line];
  }

  if (current.length > 0) {
    grouped.push(toWeightedLine(current));
  }

  return grouped;
}

function toWeightedLine(lines: Array<OcrTextLine & { height: number }>): OcrTextLine {
  const totalConfidence = lines.reduce((sum, line) => sum + line.confidence, 0);
  if (totalConfidence <= 0) {
    return {
      y: lines.reduce((sum, line) => sum + line.y, 0) / lines.length,
      confidence: 0,
    };
  }

  return {
    y: lines.reduce((sum, line) => sum + line.y * line.confidence, 0) / totalConfidence,
    confidence: Math.max(...lines.map((line) => line.confidence)),
  };
}

function percentile(values: Buffer, fraction: number): number {
  if (values.length === 0) {
    return 0;
  }

  // Counting sort over the 256 grey levels. The previous version allocated and
  // sorted a 36k-element array on every age crop.
  const histogram = new Uint32Array(256);
  for (let index = 0; index < values.length; index++) {
    histogram[values[index]]++;
  }

  const rank = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * fraction)));
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += histogram[level];
    if (seen > rank) {
      return level;
    }
  }

  return 255;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('OCR timed out')), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
