import { evaluateQuad, orderQuadPoints, type Point, type QuadQuality } from './perspectiveCorrect';

const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

declare function importScripts(...urls: string[]): void;

type WorkerRequest =
  | {
    type: 'warmup';
    requestId: string;
  }
  | {
    type: 'correct';
    requestId: string;
    imageData: ImageData;
    outputWidth: number;
    outputHeight: number;
    expectedAspectRatio: number;
    minimumConfidence: number;
  };

type CorrectResponse =
  | { type: 'ready'; requestId: string }
  | {
    type: 'result';
    requestId: string;
    ok: true;
    blob: Blob;
    confidence: number;
    method: 'perspective' | 'deskew';
  }
  | {
    type: 'result';
    requestId: string;
    ok: false;
    confidence: number;
    reason: 'no-document' | 'low-confidence' | 'worker-error';
  };

const workerSelf = self as unknown as {
  cv?: any;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: CorrectResponse) => void;
};

let openCvPromise: Promise<any> | null = null;
let importStarted = false;

function loadOpenCvInWorker(): Promise<any> {
  if (workerSelf.cv?.Mat) {
    return Promise.resolve(workerSelf.cv);
  }

  if (openCvPromise) {
    return openCvPromise;
  }

  openCvPromise = new Promise((resolve, reject) => {
    try {
      if (!importStarted) {
        importStarted = true;
        importScripts(OPENCV_SCRIPT_URL);
      }

      const cv = workerSelf.cv;
      if (!cv) {
        openCvPromise = null;
        reject(new Error('OpenCV.js loaded without exposing cv in the worker.'));
        return;
      }

      if (cv.Mat) {
        resolve(cv);
        return;
      }

      cv.onRuntimeInitialized = () => {
        resolve(cv);
      };
    } catch (error) {
      openCvPromise = null;
      reject(error);
    }
  });

  return openCvPromise;
}

function detectDocumentQuadFromMat(
  cv: any,
  source: any,
  imageWidth: number,
  imageHeight: number,
  expectedAspectRatio: number,
): { quality: QuadQuality | null; deskewAngle: number } {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const detectionMaps: any[] = [];

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    for (const thresholds of [[50, 150], [85, 220]]) {
      const edges = new cv.Mat();
      cv.Canny(blurred, edges, thresholds[0], thresholds[1]);
      detectionMaps.push(edges);
    }

    try {
      const adaptive = new cv.Mat();
      cv.adaptiveThreshold(
        gray,
        adaptive,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        31,
        11,
      );
      detectionMaps.push(adaptive);
    } catch {
      // Older OpenCV.js builds may not expose adaptiveThreshold in the Worker.
    }

    let best: QuadQuality | null = null;
    for (const detectionMap of detectionMaps) {
      const candidate = findBestQuadFromMap(
        cv,
        detectionMap,
        imageWidth,
        imageHeight,
        expectedAspectRatio,
      );

      if (!best || (candidate && candidate.confidence > best.confidence)) {
        best = candidate;
      }
    }

    return {
      quality: best,
      deskewAngle: estimateDeskewAngle(cv, detectionMaps[0], imageWidth, imageHeight),
    };
  } finally {
    detectionMaps.forEach((detectionMap) => detectionMap.delete());
    blurred.delete();
    gray.delete();
  }
}

function estimateDeskewAngle(cv: any, edges: any, imageWidth: number, imageHeight: number): number {
  if (!edges || typeof cv.HoughLinesP !== 'function') {
    return 0;
  }

  const lines = new cv.Mat();

  try {
    cv.HoughLinesP(
      edges,
      lines,
      1,
      Math.PI / 180,
      Math.max(30, Math.round(Math.min(imageWidth, imageHeight) * 0.12)),
      Math.max(40, Math.round(Math.min(imageWidth, imageHeight) * 0.25)),
      Math.max(8, Math.round(Math.min(imageWidth, imageHeight) * 0.03)),
    );

    let weightedAngle = 0;
    let totalWeight = 0;

    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];
      const length = Math.hypot(x2 - x1, y2 - y1);

      if (length <= 0) {
        continue;
      }

      let angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
      while (angle > 90) angle -= 180;
      while (angle < -90) angle += 180;
      if (angle > 45) angle -= 90;
      if (angle < -45) angle += 90;

      if (Math.abs(angle) > 12) {
        continue;
      }

      weightedAngle += angle * length;
      totalWeight += length;
    }

    if (totalWeight === 0) {
      return 0;
    }

    return Math.max(-12, Math.min(12, weightedAngle / totalWeight));
  } catch {
    return 0;
  } finally {
    lines.delete();
  }
}

function findBestQuadFromMap(
  cv: any,
  detectionMap: any,
  imageWidth: number,
  imageHeight: number,
  expectedAspectRatio: number,
): QuadQuality | null {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best: QuadQuality | null = null;

  try {
    cv.findContours(detectionMap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);

      try {
        const perimeter = cv.arcLength(contour, true);
        for (const epsilonRatio of [0.015, 0.02, 0.03]) {
          const approx = new cv.Mat();

          try {
            cv.approxPolyDP(contour, approx, perimeter * epsilonRatio, true);

            if (approx.rows !== 4 || !cv.isContourConvex(approx)) {
              continue;
            }

            const points: Point[] = [];
            for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
              points.push({
                x: approx.data32S[pointIndex * 2],
                y: approx.data32S[pointIndex * 2 + 1],
              });
            }

            const quality = evaluateQuad(points, imageWidth, imageHeight, expectedAspectRatio);
            if (quality && (!best || quality.confidence > best.confidence)) {
              best = quality;
            }
          } finally {
            approx.delete();
          }
        }
      } finally {
        contour.delete();
      }
    }

    return best;
  } finally {
    hierarchy.delete();
    contours.delete();
  }
}

async function warpToBlob(
  cv: any,
  source: any,
  quad: Point[],
  outputWidth: number,
  outputHeight: number,
): Promise<Blob> {
  const [topLeft, topRight, bottomRight, bottomLeft] = orderQuadPoints(quad);
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    topLeft.x,
    topLeft.y,
    topRight.x,
    topRight.y,
    bottomRight.x,
    bottomRight.y,
    bottomLeft.x,
    bottomLeft.y,
  ]);
  const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0,
    0,
    outputWidth - 1,
    0,
    outputWidth - 1,
    outputHeight - 1,
    0,
    outputHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const result = new cv.Mat();

  try {
    cv.warpPerspective(
      source,
      result,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    );

    return await matToBlob(cv, result, outputWidth, outputHeight);
  } finally {
    result.delete();
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
  }
}

async function deskewToBlob(
  cv: any,
  source: any,
  angle: number,
  outputWidth: number,
  outputHeight: number,
): Promise<Blob> {
  const sourceWidth = source.cols;
  const sourceHeight = source.rows;
  const radians = Math.abs(angle) * (Math.PI / 180);
  const rotatedWidth = Math.max(
    1,
    Math.round(sourceWidth * Math.cos(radians) + sourceHeight * Math.sin(radians)),
  );
  const rotatedHeight = Math.max(
    1,
    Math.round(sourceHeight * Math.cos(radians) + sourceWidth * Math.sin(radians)),
  );
  const center = new cv.Point(sourceWidth / 2, sourceHeight / 2);
  const transform = cv.getRotationMatrix2D(center, -angle, 1);
  const rotated = new cv.Mat();
  const resized = new cv.Mat();

  try {
    const transformData = transform.data64F || transform.data32F;
    if (!transformData) {
      throw new Error('Unable to read the affine transform matrix.');
    }

    transformData[2] += (rotatedWidth - sourceWidth) / 2;
    transformData[5] += (rotatedHeight - sourceHeight) / 2;
    cv.warpAffine(
      source,
      rotated,
      transform,
      new cv.Size(rotatedWidth, rotatedHeight),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    cv.resize(rotated, resized, new cv.Size(outputWidth, outputHeight), 0, 0, cv.INTER_AREA);

    return await matToBlob(cv, resized, outputWidth, outputHeight);
  } finally {
    resized.delete();
    rotated.delete();
    transform.delete();
  }
}

async function matToBlob(cv: any, mat: any, outputWidth: number, outputHeight: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Unable to create OffscreenCanvas 2D context.');
  }

  const rgba = mat.channels?.() === 4 ? mat : new cv.Mat();
  try {
    if (rgba !== mat) {
      cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA);
    }

    const pixels = new Uint8ClampedArray(rgba.data);
    context.putImageData(new ImageData(pixels, outputWidth, outputHeight), 0, 0);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  } finally {
    if (rgba !== mat) {
      rgba.delete();
    }
  }
}

async function detectAndWarp(
  cv: any,
  imageData: ImageData,
  outputWidth: number,
  outputHeight: number,
  expectedAspectRatio: number,
  minimumConfidence: number,
): Promise<
  | { found: true; blob: Blob; confidence: number; method: 'perspective' | 'deskew' }
  | { found: false; confidence: number; reason: 'no-document' | 'low-confidence' }
> {
  const source = cv.matFromImageData(imageData);

  try {
    const detection = detectDocumentQuadFromMat(
      cv,
      source,
      imageData.width,
      imageData.height,
      expectedAspectRatio,
    );
    const quality = detection.quality;

    if (quality && quality.confidence >= minimumConfidence) {
      return {
        found: true,
        confidence: quality.confidence,
        method: 'perspective',
        blob: await warpToBlob(cv, source, quality.points, outputWidth, outputHeight),
      };
    }

    if (Math.abs(detection.deskewAngle) >= 0.6 && Math.abs(detection.deskewAngle) <= 12) {
      return {
        found: true,
        confidence: Math.max(quality?.confidence || 0.55, 0.55),
        method: 'deskew',
        blob: await deskewToBlob(
          cv,
          source,
          detection.deskewAngle,
          outputWidth,
          outputHeight,
        ),
      };
    }

    if (!quality) {
      return { found: false, confidence: 0, reason: 'no-document' };
    }

    return { found: false, confidence: quality.confidence, reason: 'low-confidence' };
  } finally {
    source.delete();
  }
}

workerSelf.onmessage = (event) => {
  const message = event.data;
  if (!message || (message.type !== 'correct' && message.type !== 'warmup')) {
    return;
  }

  void (async () => {
    try {
      const cv = await loadOpenCvInWorker();

      if (message.type === 'warmup') {
        workerSelf.postMessage({ type: 'ready', requestId: message.requestId });
        return;
      }

      const result = await detectAndWarp(
        cv,
        message.imageData,
        message.outputWidth,
        message.outputHeight,
        message.expectedAspectRatio,
        message.minimumConfidence,
      );

      if (!result.found) {
        workerSelf.postMessage({
          type: 'result',
          requestId: message.requestId,
          ok: false,
          confidence: result.confidence,
          reason: result.reason,
        });
        return;
      }

      workerSelf.postMessage({
        type: 'result',
        requestId: message.requestId,
        ok: true,
        blob: result.blob,
        confidence: result.confidence,
        method: result.method,
      });
    } catch {
      workerSelf.postMessage({
        type: 'result',
        requestId: message.requestId,
        ok: false,
        confidence: 0,
        reason: 'worker-error',
      });
    }
  })();
};

export {};
