import { orderQuadPoints, type Point } from './perspectiveCorrect';

const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

declare function importScripts(...urls: string[]): void;

type CorrectRequest = {
  type: 'correct';
  requestId: string;
  imageData: ImageData;
  outputWidth: number;
  outputHeight: number;
};

type CorrectResponse =
  | { type: 'result'; requestId: string; ok: true; blob: Blob }
  | { type: 'result'; requestId: string; ok: false };

const workerSelf = self as unknown as {
  cv?: any;
  onmessage: ((event: MessageEvent<CorrectRequest>) => void) | null;
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

function detectDocumentQuadFromMat(cv: any, source: any, imageWidth: number, imageHeight: number): Point[] | null {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 75, 200);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = imageWidth * imageHeight;
    const minDocumentArea = imageArea * 0.2;
    let bestArea = 0;
    let bestQuad: Point[] | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();

      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, perimeter * 0.02, true);

        if (approx.rows !== 4 || !cv.isContourConvex(approx)) {
          continue;
        }

        const area = Math.abs(cv.contourArea(approx));
        if (area < minDocumentArea || area <= bestArea) {
          continue;
        }

        const points: Point[] = [];
        for (let pointIndex = 0; pointIndex < 4; pointIndex++) {
          points.push({
            x: approx.data32S[pointIndex * 2],
            y: approx.data32S[pointIndex * 2 + 1],
          });
        }

        bestArea = area;
        bestQuad = points;
      } finally {
        approx.delete();
        contour.delete();
      }
    }

    return bestQuad;
  } finally {
    hierarchy.delete();
    contours.delete();
    edges.delete();
    blurred.delete();
    gray.delete();
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
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');

  if (!context) {
    result.delete();
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
    throw new Error('Unable to create OffscreenCanvas 2D context.');
  }

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

    const rgba = result.channels?.() === 4 ? result : new cv.Mat();
    try {
      if (rgba !== result) {
        cv.cvtColor(result, rgba, cv.COLOR_RGB2RGBA);
      }

      const pixels = new Uint8ClampedArray(rgba.data);
      context.putImageData(new ImageData(pixels, outputWidth, outputHeight), 0, 0);
    } finally {
      if (rgba !== result) {
        rgba.delete();
      }
    }

    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  } finally {
    result.delete();
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
  }
}

async function detectAndWarp(
  cv: any,
  imageData: ImageData,
  outputWidth: number,
  outputHeight: number,
): Promise<{ found: true; blob: Blob } | { found: false }> {
  const source = cv.matFromImageData(imageData);

  try {
    const quad = detectDocumentQuadFromMat(cv, source, imageData.width, imageData.height);
    if (!quad) {
      return { found: false };
    }

    return {
      found: true,
      blob: await warpToBlob(cv, source, quad, outputWidth, outputHeight),
    };
  } finally {
    source.delete();
  }
}

workerSelf.onmessage = (event) => {
  const message = event.data;
  if (message?.type !== 'correct') {
    return;
  }

  void (async () => {
    try {
      const cv = await loadOpenCvInWorker();
      const result = await detectAndWarp(cv, message.imageData, message.outputWidth, message.outputHeight);

      if (!result.found) {
        workerSelf.postMessage({ type: 'result', requestId: message.requestId, ok: false });
        return;
      }

      workerSelf.postMessage({
        type: 'result',
        requestId: message.requestId,
        ok: true,
        blob: result.blob,
      });
    } catch {
      workerSelf.postMessage({ type: 'result', requestId: message.requestId, ok: false });
    }
  })();
};

export {};
