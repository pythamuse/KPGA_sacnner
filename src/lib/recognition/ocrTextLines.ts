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

    if (perDigit && wholeBoxValue !== undefined && perDigitValue !== undefined) {
      if (wholeBoxValue !== perDigitValue) {
        return {
          status: 'parse_or_confidence_rejected',
          diagnostic: `Age OCR rejected [gate=readers-disagreed]: the two readings were different numbers. ${evidence}`,
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
  strokes: Array<{ width: number; height: number }>;
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

  return `[crop=${shape.cropWidth}x${shape.cropHeight} work=${shape.workWidth}x${shape.workHeight}`
    + ` tmpl=${shape.template} otsu=${shape.otsu} ink=${shape.inkPermille}/1000`
    + ` strokes=${shape.strokes.length}(${strokes}${extra})]`;
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
  const parts = reading.parts && reading.parts.length > 1
    ? `(${reading.parts.slice(0, 4).map((part) => Math.round(part)).join(',')})`
    : '';

  return `"${shown}" conf=${Math.round(reading.confidence)}${parts}${length}${nonDigits}`;
}

interface DigitReading {
  text: string;
  confidence: number;
  /** Confidence of each separately-read digit, when there was more than one. */
  parts?: number[];
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
    const parts: number[] = [];
    for (const stroke of ordered) {
      const image = await renderStrokesForOcr(strokes.mask, [stroke]);
      const reading = await readWith(worker, image, PSM.SINGLE_CHAR);
      text += reading.text;
      confidence = Math.min(confidence, reading.confidence);
      parts.push(reading.confidence);
    }

    return { wholeBox, perDigit: { text, confidence, parts } };
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
 * structure is erased by shape (long horizontal runs, thin full-height columns)
 * and the black/white split is taken from the crop's own histogram. Nothing in
 * this path relaxes `MIN_DIGIT_CONFIDENCE`; a cleaner image is the only way a
 * value gets through.
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
  };

  if (inkCount < mask.data.length * DIGIT_MIN_INK_FRACTION) {
    return { shape };
  }

  eraseHorizontalRules(mask);
  const strokes = keepDigitStrokes(mask);
  shape.strokes = strokes.map((stroke) => ({
    width: stroke.right - stroke.left + 1,
    height: stroke.bottom - stroke.top + 1,
  }));
  if (strokes.length === 0) {
    return { shape };
  }

  return { found: { mask, strokes }, shape };
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
 * Erases the printed rule that runs under the age digits. A rule is a dark run
 * covering most of the box width, which no handwritten stroke does. Where a
 * digit crosses the rule the pixels are kept, so a "4" that sits on the line
 * does not lose its stem.
 */
function eraseHorizontalRules(mask: InkMask): void {
  const { data, width, height } = mask;
  const minRun = Math.max(8, Math.round(width * DIGIT_RULE_RUN_FRACTION));
  const bands: Array<{ top: number; bottom: number }> = [];

  for (let y = 0; y < height; y++) {
    let run = 0;
    let longestRun = 0;
    for (let x = 0; x < width; x++) {
      run = data[y * width + x] ? run + 1 : 0;
      if (run > longestRun) {
        longestRun = run;
      }
    }
    if (longestRun < minRun) {
      continue;
    }
    const last = bands[bands.length - 1];
    if (last && y <= last.bottom + 1) {
      last.bottom = y;
    } else {
      bands.push({ top: y, bottom: y });
    }
  }

  for (const band of bands) {
    const above = band.top - 1;
    const below = band.bottom + 1;
    for (let x = 0; x < width; x++) {
      const strokeCrosses = above >= 0
        && below < height
        && hasInkNear(mask, x, above)
        && hasInkNear(mask, x, below);
      if (strokeCrosses) {
        continue;
      }
      for (let y = band.top; y <= band.bottom; y++) {
        data[y * width + x] = 0;
      }
    }
  }
}

function hasInkNear(mask: InkMask, x: number, y: number): boolean {
  for (let offset = -1; offset <= 1; offset++) {
    const column = x + offset;
    if (column < 0 || column >= mask.width) {
      continue;
    }
    if (mask.data[y * mask.width + column]) {
      return true;
    }
  }
  return false;
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
