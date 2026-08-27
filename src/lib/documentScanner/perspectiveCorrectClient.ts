import type { QuadRejection } from './perspectiveCorrect';
import type { FrameExposureSample, LiveQuadQuality } from './captureGuidance';

export type PerspectiveCorrectionReason =
  | 'no-document'
  | 'low-confidence'
  | 'timeout'
  | 'worker-error';

/**
 * How the correction registered the sheet, produced on success AND failure
 * (FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md §F1.2). F2 reads this to ask
 * for a retake, F3 folds it into the per-sheet verdict.
 */
export interface RegistrationMeta {
  method: 'quad' | 'orb' | 'none';
  /** Quad confidence; 0 when the registration is ORB-alone. */
  confidence: number;
  orbInliers: number;
  /** inliers / good matches. */
  orbInlierRatio: number;
  /** Median quad-H residual over ORB inlier pairs (template-frame px), null when unmeasurable. */
  quadResidualPx: number | null;
  rejection: QuadRejection | null;
  /** Did the adopted homography pass its verification threshold? */
  verified: boolean;
  /** Set by the panel when the user explicitly proceeds past a retake prompt (spec F2.3). */
  overridden?: boolean;
}

export interface PerspectiveCorrectionResult {
  status: 'corrected' | 'skipped';
  method: 'perspective' | 'deskew' | 'none';
  confidence: number;
  blob: Blob | null;
  reason?: PerspectiveCorrectionReason;
  registration: RegistrationMeta;
}

type WorkerRequest =
  | { type: 'warmup'; requestId: string }
  | {
    type: 'correct';
    requestId: string;
    imageData: ImageData;
    outputWidth: number;
    outputHeight: number;
    expectedAspectRatio: number;
    minimumConfidence: number;
    /** Selects the ORB template; omitted by legacy call sites (quad-only behavior). */
    formType?: 'cagi' | 'satisfaction';
  }
  | {
    /** Live guidance frame: quad detection only (CAPTURE_GUIDANCE §7). */
    type: 'detect';
    requestId: string;
    imageData: ImageData;
    expectedAspectRatio: number;
  };

type WorkerResponse =
  | { type: 'ready'; requestId: string }
  | {
    type: 'detect-result';
    requestId: string;
    quality: LiveQuadQuality | null;
    rejection: QuadRejection | null;
    width: number;
    height: number;
    /** Optional so a worker build predating the tone pass still parses. */
    exposure?: FrameExposureSample | null;
  }
  | {
    type: 'result';
    requestId: string;
    ok: true;
    blob: Blob;
    confidence: number;
    method: 'perspective' | 'deskew';
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

type InFlightRequest = {
  worker: Worker;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (response: WorkerResponse | null) => void;
};

let workerInstance: Worker | null = null;
let requestCounter = 0;
const inFlightRequests = new Map<string, InFlightRequest>();

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  requestCounter += 1;
  return `${Date.now()}-${requestCounter}`;
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

function settleRequest(requestId: string, response: WorkerResponse | null) {
  const request = inFlightRequests.get(requestId);
  if (!request) {
    return;
  }

  clearTimeout(request.timeoutId);
  inFlightRequests.delete(requestId);
  request.resolve(response);
}

function terminateWorker(worker: Worker) {
  worker.terminate();

  if (workerInstance === worker) {
    workerInstance = null;
  }

  const requestIdsToSettle: string[] = [];

  inFlightRequests.forEach((request, requestId) => {
    if (request.worker === worker) {
      requestIdsToSettle.push(requestId);
    }
  });

  for (const requestId of requestIdsToSettle) {
    const request = inFlightRequests.get(requestId);
    if (!request) {
      continue;
    }

    clearTimeout(request.timeoutId);
    inFlightRequests.delete(requestId);
    request.resolve(null);
  }
}

function getWorker(): Worker | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (workerInstance) {
    return workerInstance;
  }

  const worker = new Worker(new URL('./perspectiveCorrect.worker.ts', import.meta.url));

  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (
      !message ||
      (message.type !== 'ready' && message.type !== 'result' && message.type !== 'detect-result')
    ) {
      return;
    }

    settleRequest(message.requestId, message);
  });

  worker.addEventListener('error', () => {
    terminateWorker(worker);
  });

  workerInstance = worker;
  return worker;
}

/**
 * What a timeout means.
 *
 * `terminate` is the original behavior and stays the default: a correction
 * that never came back has left the worker in an unknown state, and the panel
 * is about to show a retake prompt anyway.
 *
 * `abandon` exists for the live guidance loop. Killing the shared worker
 * because one preview frame ran long would also kill an in-flight correction
 * and force the next frame to re-import the 10MB OpenCV build -- a stall that
 * is far worse than the dropped frame it was reacting to. The request is
 * simply forgotten; a late reply finds no entry and is ignored.
 */
type TimeoutPolicy = 'terminate' | 'abandon';

function requestWorker(
  worker: Worker,
  message: WorkerRequest,
  timeoutMs: number,
  transfer?: Transferable[],
  onTimeout: TimeoutPolicy = 'terminate',
): Promise<WorkerResponse | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (onTimeout === 'abandon') {
        const request = inFlightRequests.get(message.requestId);
        if (request) {
          inFlightRequests.delete(message.requestId);
          request.resolve(null);
        }
        return;
      }

      terminateWorker(worker);
    }, timeoutMs);

    inFlightRequests.set(message.requestId, {
      worker,
      timeoutId,
      resolve,
    });

    try {
      // The pixel buffer is transferred, not cloned: a full-resolution photo
      // is ~46MB of RGBA and copying it stalls the main thread.
      worker.postMessage(message, transfer ?? []);
    } catch {
      terminateWorker(worker);
    }
  });
}

export async function warmupPerspectiveWorker(timeoutMs = 9000): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false;
  }

  const worker = getWorker();
  if (!worker) {
    return false;
  }

  const response = await requestWorker(worker, {
    type: 'warmup',
    requestId: createRequestId(),
  }, timeoutMs);

  return response?.type === 'ready';
}

export async function correctImageInWorkerDetailed(
  bitmapSource: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
  timeoutMs: number,
  minimumConfidence = 0.58,
  formType?: 'cagi' | 'satisfaction',
): Promise<PerspectiveCorrectionResult> {
  const skipped = (reason: PerspectiveCorrectionReason, confidence = 0): PerspectiveCorrectionResult => ({
    status: 'skipped',
    method: 'none',
    confidence,
    blob: null,
    reason,
    registration: emptyRegistration(),
  });

  if (typeof window === 'undefined') {
    return skipped('worker-error');
  }

  const worker = getWorker();
  if (!worker) {
    return skipped('worker-error');
  }

  const context = bitmapSource.getContext('2d');
  if (!context) {
    return skipped('worker-error');
  }

  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, bitmapSource.width, bitmapSource.height);
  } catch {
    return skipped('worker-error');
  }

  const response = await requestWorker(worker, {
    type: 'correct',
    requestId: createRequestId(),
    imageData,
    outputWidth,
    outputHeight,
    expectedAspectRatio: outputHeight / outputWidth,
    minimumConfidence,
    formType,
  }, timeoutMs, [imageData.data.buffer]);

  if (!response) {
    return skipped('timeout');
  }

  if (response.type !== 'result') {
    return skipped('worker-error');
  }

  if (!response.ok) {
    return {
      status: 'skipped',
      method: 'none',
      confidence: response.confidence,
      blob: null,
      reason: response.reason,
      registration: response.registration ?? emptyRegistration(),
    };
  }

  return {
    status: 'corrected',
    method: response.method,
    confidence: response.confidence,
    blob: response.blob,
    registration: response.registration ?? emptyRegistration(),
  };
}

/** Reply shape of a live guidance frame; points are in `width` x `height`. */
export interface LiveQuadDetection {
  quality: LiveQuadQuality | null;
  rejection: QuadRejection | null;
  width: number;
  height: number;
  /**
   * Tone of the sheet in this frame (CAPTURE_GUIDANCE §11.3), or null when it
   * could not be measured. Computed inside the worker, on the ImageData this
   * function transfers there: reading it back out on the main thread would mean
   * a second full `getImageData` per tick for a pass the worker does in
   * microseconds while it already holds the pixels.
   */
  exposure: FrameExposureSample | null;
}

/**
 * One live guidance frame (CAPTURE_GUIDANCE §7).
 *
 * `source` must ALREADY be the small detection frame -- the worker does not
 * resize for this path, and the whole point of the live budget is that the
 * pixels never get large. Returns null when the worker is unavailable, the
 * frame is unreadable, or the request timed out; the caller drops that frame
 * and asks again rather than showing an error.
 */
export async function detectQuadInWorker(
  source: HTMLCanvasElement,
  expectedAspectRatio: number,
  timeoutMs = 1200,
): Promise<LiveQuadDetection | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  const worker = getWorker();
  if (!worker) {
    return null;
  }

  const context = source.getContext('2d');
  if (!context || source.width <= 0 || source.height <= 0) {
    return null;
  }

  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, source.width, source.height);
  } catch {
    return null;
  }

  const response = await requestWorker(worker, {
    type: 'detect',
    requestId: createRequestId(),
    imageData,
    expectedAspectRatio,
  }, timeoutMs, [imageData.data.buffer], 'abandon');

  if (!response || response.type !== 'detect-result') {
    return null;
  }

  return {
    quality: response.quality,
    rejection: response.rejection,
    width: response.width,
    height: response.height,
    exposure: response.exposure ?? null,
  };
}

export async function correctImageInWorker(
  bitmapSource: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
  timeoutMs: number,
  minimumConfidence = 0.58,
  formType?: 'cagi' | 'satisfaction',
): Promise<Blob | null> {
  const result = await correctImageInWorkerDetailed(
    bitmapSource,
    outputWidth,
    outputHeight,
    timeoutMs,
    minimumConfidence,
    formType,
  );

  return result.blob;
}
