export type PerspectiveCorrectionReason =
  | 'no-document'
  | 'low-confidence'
  | 'timeout'
  | 'worker-error';

export interface PerspectiveCorrectionResult {
  status: 'corrected' | 'skipped';
  method: 'perspective' | 'deskew' | 'none';
  confidence: number;
  blob: Blob | null;
  reason?: PerspectiveCorrectionReason;
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
  }
  | {
    type: 'result';
    requestId: string;
    ok: false;
    confidence: number;
    reason: 'no-document' | 'low-confidence' | 'worker-error';
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
      worker.postMessage(message);
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
): Promise<PerspectiveCorrectionResult> {
  const skipped = (reason: PerspectiveCorrectionReason, confidence = 0): PerspectiveCorrectionResult => ({
    status: 'skipped',
    method: 'none',
    confidence,
    blob: null,
    reason,
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
  }, timeoutMs);

  if (!response) {
    return skipped('timeout');
  }

  if (response.type !== 'result') {
    return skipped('worker-error');
  }

  if (!response.ok) {
    return skipped(response.reason, response.confidence);
  }

  return {
    status: 'corrected',
    method: response.method,
    confidence: response.confidence,
    blob: response.blob,
  };
}

export async function correctImageInWorker(
  bitmapSource: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
  timeoutMs: number,
  minimumConfidence = 0.58,
): Promise<Blob | null> {
  const result = await correctImageInWorkerDetailed(
    bitmapSource,
    outputWidth,
    outputHeight,
    timeoutMs,
    minimumConfidence,
  );

  return result.blob;
}
