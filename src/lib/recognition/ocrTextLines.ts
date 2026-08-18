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

let workerPromise: Promise<Worker> | null = null;
let workerReady = false;
let digitWorkerPromise: Promise<Worker> | null = null;
let digitWorkerReady = false;
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

async function recognizeDigitsCropDetailed(
  imageBuffer: Buffer,
  crop: { left: number; top: number; width: number; height: number },
  templateReference?: DigitTemplateReference,
): Promise<DigitOcrResult> {
  try {
    const targetWidth = Math.max(crop.width * 4, 320);
    // Preserve the small age box's natural aspect ratio. Stretching a
    // 95x24 crop to a 120px minimum height turns a handwritten "4" into a
    // loop-like shape that Tesseract repeatedly misread as "9".
    const targetHeight = Math.max(crop.height * 4, 96);
    const { data: croppedPixels } = await sharp(imageBuffer)
      .rotate()
      .extract(crop)
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ocrPixels = templateReference
      ? await subtractTemplateDigits(croppedPixels, targetWidth, targetHeight, templateReference)
      : croppedPixels;
    const croppedBuffer = await sharp(ocrPixels, {
      raw: { width: targetWidth, height: targetHeight, channels: 1 },
    })
      .normalise()
      .sharpen({ sigma: 1.1 })
      .threshold(190)
      .png()
      .toBuffer();

    const worker = await getDigitWorker();
    const result = await worker.recognize(croppedBuffer, {}, { text: true });
    const value = parseTrustedAgeOcrText(result.data.text, result.data.confidence);
    if (value !== undefined) {
      return {
        value,
        status: 'accepted',
        diagnostic: 'Age OCR was accepted after template subtraction and confidence checks.',
      };
    }

    return {
      status: 'parse_or_confidence_rejected',
      diagnostic: 'Age OCR result did not pass the digit range or confidence check.',
    };
  } catch {
    return {
      status: 'timeout_or_error',
      diagnostic: 'Age OCR failed while processing the digit box.',
    };
  }
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
    // strokes that are materially darker than the printed template at the
    // matching position.
    const addedInk = blankPixels[index] - normalizedActual;
    if (addedInk > 24) {
      output[index] = Math.max(0, 255 - (addedInk - 24) * 5);
    }
  }

  return output;
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
  const sorted = Array.from(values).sort((first, second) => first - second);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
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
