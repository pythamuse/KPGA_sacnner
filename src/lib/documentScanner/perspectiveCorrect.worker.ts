import { orderQuadPoints, type Point, type QuadRejection } from './perspectiveCorrect';
import { detectDocumentQuadFromMat } from './detectDocumentQuad';
import {
  alignToTemplate,
  composeToFullRes,
  decideRegistration,
  multiplyHomographies,
  type OrbAlignment,
  type OrbTemplate,
} from './orbAlign';
import cagiOrbTemplateJson from './orbTemplate.cagi.json';
import satisfactionOrbTemplateJson from './orbTemplate.satisfaction.json';

const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

/**
 * Long side of the internal detection copy. Detection stays at the scale it
 * was measured at (the panel used to downscale to 1600 before sending); only
 * the warp now samples the full-resolution input -- warping from the
 * downscale is what created 3 new wrong answers on p2
 * (Task/EXTERNAL_ADOPTION_PLAN_2026-08-27.md §3.3).
 */
const DETECTION_LONG_SIDE = 1600;

declare function importScripts(...urls: string[]): void;

const ORB_TEMPLATES: Record<'cagi' | 'satisfaction', OrbTemplate> = {
  cagi: cagiOrbTemplateJson as unknown as OrbTemplate,
  satisfaction: satisfactionOrbTemplateJson as unknown as OrbTemplate,
};

/** Mirrors RegistrationMeta in perspectiveCorrectClient.ts (the exported home of the type). */
interface RegistrationMeta {
  method: 'quad' | 'orb' | 'none';
  confidence: number;
  orbInliers: number;
  orbInlierRatio: number;
  quadResidualPx: number | null;
  rejection: QuadRejection | null;
  verified: boolean;
}

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
    /**
     * Selects the committed ORB template. Optional for backward
     * compatibility: without it the ORB route cannot run (there is no
     * template to align against) and the worker behaves exactly as the
     * quad-only version did. The call-site upgrade that always sends it is a
     * later track (spec §5.1 T4).
     */
    formType?: 'cagi' | 'satisfaction';
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
    registration: RegistrationMeta;
  }
  | {
    type: 'result';
    requestId: string;
    ok: false;
    confidence: number;
    reason: 'no-document' | 'low-confidence' | 'worker-error';
    rejection?: QuadRejection | null;
    registration: RegistrationMeta;
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

function emptyRegistration(): RegistrationMeta {
  return {
    method: 'none',
    confidence: 0,
    orbInliers: 0,
    orbInlierRatio: 0,
    quadResidualPx: null,
    rejection: null,
    verified: false,
  };
}

/**
 * Homography (9 numbers, row-major) that maps the ordered quad in the
 * detection frame onto the outputWidth x outputHeight rectangle.
 */
function quadHomography(
  cv: any,
  quad: Point[],
  outputWidth: number,
  outputHeight: number,
): number[] {
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

  try {
    return Array.from(transform.data64F.slice(0, 9)) as number[];
  } finally {
    transform.delete();
    destinationPoints.delete();
    sourcePoints.delete();
  }
}

/** Warps the FULL-RESOLUTION source with a homography given as 9 numbers. */
async function warpWithHomography(
  cv: any,
  sourceFull: any,
  homography: number[],
  outputWidth: number,
  outputHeight: number,
): Promise<Blob> {
  const transform = cv.matFromArray(3, 3, cv.CV_64F, homography);
  const result = new cv.Mat();

  try {
    cv.warpPerspective(
      sourceFull,
      result,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      // White border: the sheet itself is white, and the ORB route can map
      // regions the photo never covered -- a black fill there would read as
      // massive ink to every downstream density signal.
      new cv.Scalar(255, 255, 255, 255),
    );

    return await matToBlob(cv, result, outputWidth, outputHeight);
  } finally {
    result.delete();
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
  formType: 'cagi' | 'satisfaction' | undefined,
): Promise<
  | { found: true; blob: Blob; confidence: number; method: 'perspective'; registration: RegistrationMeta }
  | {
    found: false;
    confidence: number;
    reason: 'no-document' | 'low-confidence';
    rejection?: QuadRejection | null;
    registration: RegistrationMeta;
  }
> {
  const fullWidth = imageData.width;
  const fullHeight = imageData.height;
  // The full-res RGBA Mat is ~46MB at 12MP; it exists exactly as long as the
  // warp needs it and everything else works on the detection copy.
  const sourceFull = cv.matFromImageData(imageData);

  let detection = sourceFull;
  let detectionOwned = false;
  let detectionWidth = fullWidth;
  let detectionHeight = fullHeight;

  try {
    const longSide = Math.max(fullWidth, fullHeight);
    if (longSide > DETECTION_LONG_SIDE) {
      const scale = DETECTION_LONG_SIDE / longSide;
      detectionWidth = Math.max(1, Math.round(fullWidth * scale));
      detectionHeight = Math.max(1, Math.round(fullHeight * scale));
      detection = new cv.Mat();
      detectionOwned = true;
      cv.resize(sourceFull, detection, new cv.Size(detectionWidth, detectionHeight), 0, 0, cv.INTER_AREA);
    }

    // Route 1: quad detection, at the detection scale it was measured at.
    const { quality, rejection } = detectDocumentQuadFromMat(
      cv,
      detection,
      detectionWidth,
      detectionHeight,
      expectedAspectRatio,
    );
    const quadAccepted = Boolean(quality && quality.confidence >= minimumConfidence);

    // Route 2: ORB registration against the committed blank-template
    // features. Always runs when a template is known -- as the fallback when
    // the quad is rejected, and as the verifier when it is not
    // (spec §F1.2: p14's displaced corner and p10's stretched warp are
    // invisible to the quad gate but visible to the ORB residual).
    let alignment: OrbAlignment | null = null;
    const template = formType ? ORB_TEMPLATES[formType] : null;
    if (template) {
      const gray = new cv.Mat();
      try {
        cv.cvtColor(detection, gray, cv.COLOR_RGBA2GRAY);
        alignment = alignToTemplate(cv, gray, template);
      } finally {
        gray.delete();
      }
    }

    // Quad homography into the output frame, and -- for the residual check --
    // into the template frame the ORB pairs live in. In production the two
    // frames are identical (output 1422x1968 = template 1422x1968), so the
    // scaling is an identity; it is kept for callers that request another
    // output size.
    let quadToOutput: number[] | null = null;
    let quadToTemplate: number[] | null = null;
    if (quadAccepted && quality) {
      quadToOutput = quadHomography(cv, quality.points, outputWidth, outputHeight);
      quadToTemplate = template
        ? multiplyHomographies(
          [template.width / outputWidth, 0, 0, 0, template.height / outputHeight, 0, 0, 0, 1],
          quadToOutput,
        )
        : null;
    }

    const decision = decideRegistration({
      quadAccepted,
      quadHomographyToTemplate: quadToTemplate,
      alignment,
    });

    const registration: RegistrationMeta = {
      method: decision.method,
      // Quad confidence when the quad detector produced one, 0 for orb-alone.
      confidence: quality?.confidence ?? 0,
      orbInliers: alignment?.inliers ?? 0,
      orbInlierRatio: alignment?.inlierRatio ?? 0,
      quadResidualPx: decision.quadResidualPx,
      rejection: quality ? null : rejection,
      verified: decision.verified,
    };

    if (decision.method === 'none') {
      if (!quality) {
        // `rejection` names what a person can change -- the sheet ran off the
        // frame, it is too far away, it is not page-shaped. Collapsing all
        // three into `no-document` is what left the panel with nothing to say.
        return { found: false, confidence: 0, reason: 'no-document', rejection, registration };
      }

      return { found: false, confidence: quality.confidence, reason: 'low-confidence', registration };
    }

    let homographyDetectionToOutput: number[];
    if (decision.method === 'quad') {
      homographyDetectionToOutput = quadToOutput as number[];
    } else {
      // ORB homography maps detection frame -> template frame; rescale into
      // the requested output frame (identity in production, see above).
      const orbHomography = (alignment as OrbAlignment).homography as number[];
      const orbTemplate = template as OrbTemplate;
      homographyDetectionToOutput = multiplyHomographies(
        [outputWidth / orbTemplate.width, 0, 0, 0, outputHeight / orbTemplate.height, 0, 0, 0, 1],
        orbHomography,
      );
    }

    // Estimated at detection scale, warped at full resolution: compose with
    // the downscale factors so the homography accepts full-res coordinates,
    // then sample the ORIGINAL pixels (spec §F1.2 item 4).
    const homographyFull = composeToFullRes(
      homographyDetectionToOutput,
      detectionWidth / fullWidth,
      detectionHeight / fullHeight,
    );

    if (detectionOwned) {
      // Free the detection copy before the warp allocates the output Mat.
      detection.delete();
      detectionOwned = false;
    }

    const blob = await warpWithHomography(cv, sourceFull, homographyFull, outputWidth, outputHeight);

    return {
      found: true,
      blob,
      confidence: quality?.confidence ?? 0,
      method: 'perspective',
      registration,
    };
  } finally {
    if (detectionOwned) {
      detection.delete();
    }
    sourceFull.delete();
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
        message.formType,
      );

      if (!result.found) {
        workerSelf.postMessage({
          type: 'result',
          requestId: message.requestId,
          ok: false,
          confidence: result.confidence,
          reason: result.reason,
          rejection: 'rejection' in result ? result.rejection ?? null : null,
          registration: result.registration,
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
        registration: result.registration,
      });
    } catch {
      workerSelf.postMessage({
        type: 'result',
        requestId: message.requestId,
        ok: false,
        confidence: 0,
        reason: 'worker-error',
        registration: emptyRegistration(),
      });
    }
  })();
};

export {};
