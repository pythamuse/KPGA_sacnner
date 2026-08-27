import type { QuadRejection } from './perspectiveCorrect';

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
  };

type WorkerResponse =
  | { type: 'ready'; requestId: string }
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
    if (!message || (message.type !== 'ready' && message.type !== 'result')) {
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

function requestWorker(
  worker: Worker,
  message: WorkerRequest,
  timeoutMs: number,
  transfer?: Transferable[],
): Promise<WorkerResponse | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
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
