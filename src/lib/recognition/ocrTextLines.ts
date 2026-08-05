import sharp from 'sharp';
import os from 'os';
import path from 'path';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

export interface OcrTextLine {
  y: number;
  confidence: number;
}

export interface OcrOptions {
  deadlineAt?: number;
}

const MIN_CONFIDENCE = 30;
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
const OCR_TOTAL_TIMEOUT_MS = 2_500;
const OCR_CACHE_PATH = path.join(os.tmpdir(), 'gambling-prevention-tesseract-cache');

let workerPromise: Promise<Worker> | null = null;
let workerReady = false;
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
