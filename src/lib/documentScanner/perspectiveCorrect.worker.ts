import { orderQuadPoints, type Point, type QuadRejection } from './perspectiveCorrect';
import { detectDocumentQuadFromMat } from './detectDocumentQuad';

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
    method: 'perspective';
  }
  | {
    type: 'result';
    requestId: string;
    ok: false;
    confidence: number;
    reason: 'no-document' | 'low-confidence' | 'worker-error';
    rejection?: QuadRejection | null;
  };

const workerSelf = self as unknown as {
  cv?: any;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: CorrectResponse) => void;
};

// `cv` is an emscripten Module, and an emscripten Module carries its own
// `then` method -- which makes it a *thenable*. Resolving a promise with it
// hands control to that method, which resolves to the module again, so the
// promise never settles. Awaiting it has the same effect. Every correction
// request therefore sat here until the client's timeout fired, terminated the
// worker, and reported `timeout`; the panel then uploaded the original photo
// unchanged. Keep `cv` inside a box so no promise ever sees the thenable.
type OpenCvBox = { cv: any };

let openCvPromise: Promise<OpenCvBox> | null = null;
let importStarted = false;

function loadOpenCvInWorker(): Promise<OpenCvBox> {
  if (workerSelf.cv?.Mat) {
    return Promise.resolve({ cv: workerSelf.cv });
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
        resolve({ cv });
        return;
      }

      cv.onRuntimeInitialized = () => {
        resolve({ cv });
      };
    } catch (error) {
      openCvPromise = null;
      reject(error);
    }
  });

  return openCvPromise;
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
  | { found: true; blob: Blob; confidence: number; method: 'perspective' }
  | { found: false; confidence: number; reason: 'no-document' | 'low-confidence'; rejection?: QuadRejection | null }
> {
  const source = cv.matFromImageData(imageData);

  try {
    const { quality, rejection } = detectDocumentQuadFromMat(
      cv,
      source,
      imageData.width,
      imageData.height,
      expectedAspectRatio,
    );
    if (quality && quality.confidence >= minimumConfidence) {
      return {
        found: true,
        confidence: quality.confidence,
        method: 'perspective',
        blob: await warpToBlob(cv, source, quality.points, outputWidth, outputHeight),
      };
    }

    // Do not deskew from arbitrary long lines. Form tables have prominent
    // horizontal edges, and rotating/resizing from those untrusted lines can
    // turn an inner table into a page-sized image that pollutes form typing.
    if (!quality) {
      // `rejection` names what a person can change -- the sheet ran off the
      // frame, it is too far away, it is not page-shaped. Collapsing all three
      // into `no-document` is what left the panel with nothing to say.
      return { found: false, confidence: 0, reason: 'no-document', rejection };
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
      const { cv } = await loadOpenCvInWorker();

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
          rejection: 'rejection' in result ? result.rejection ?? null : null,
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
