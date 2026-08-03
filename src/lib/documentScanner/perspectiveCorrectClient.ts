type WorkerRequest = {
  type: 'correct';
  requestId: string;
  imageData: ImageData;
  outputWidth: number;
  outputHeight: number;
};

type WorkerResponse =
  | { type: 'result'; requestId: string; ok: true; blob: Blob }
  | { type: 'result'; requestId: string; ok: false };

type InFlightRequest = {
  worker: Worker;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (blob: Blob | null) => void;
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

function settleRequest(requestId: string, blob: Blob | null) {
  const request = inFlightRequests.get(requestId);
  if (!request) {
    return;
  }

  clearTimeout(request.timeoutId);
  inFlightRequests.delete(requestId);
  request.resolve(blob);
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

  for (let i = 0; i < requestIdsToSettle.length; i++) {
    const requestId = requestIdsToSettle[i];
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
    if (message?.type !== 'result') {
      return;
    }

    settleRequest(message.requestId, message.ok ? message.blob : null);
  });

  worker.addEventListener('error', () => {
    terminateWorker(worker);
  });

  workerInstance = worker;
  return workerInstance;
}

export function correctImageInWorker(
  bitmapSource: HTMLCanvasElement,
  outputWidth: number,
  outputHeight: number,
  timeoutMs: number,
): Promise<Blob | null> {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }

  const worker = getWorker();
  if (!worker) {
    return Promise.resolve(null);
  }

  const context = bitmapSource.getContext('2d');
  if (!context) {
    return Promise.resolve(null);
  }

  let imageData: ImageData;
  try {
    imageData = context.getImageData(0, 0, bitmapSource.width, bitmapSource.height);
  } catch {
    return Promise.resolve(null);
  }

  const requestId = createRequestId();
  const message: WorkerRequest = {
    type: 'correct',
    requestId,
    imageData,
    outputWidth,
    outputHeight,
  };

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      terminateWorker(worker);
    }, timeoutMs);

    inFlightRequests.set(requestId, {
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
