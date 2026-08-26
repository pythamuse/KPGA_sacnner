const OPENCV_SCRIPT_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

declare global {
  interface Window {
    cv?: any;
  }
}

// Same thenable trap as the worker loader: an emscripten Module carries a
// `then` method, so a promise resolved with `cv` adopts it and never settles.
// Box it. This module currently has no callers -- the live path is the worker
// -- but the bug is identical and would hang the first caller that appeared.
type OpenCvBox = { cv: any };

let openCvPromise: Promise<OpenCvBox> | null = null;

export function loadOpenCv(): Promise<OpenCvBox> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('OpenCV.js can only be loaded in a browser.'));
  }

  if (window.cv?.Mat) {
    return Promise.resolve({ cv: window.cv });
  }

  if (openCvPromise) {
    return openCvPromise;
  }

  openCvPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-document-scanner-opencv="true"]`,
    );
    const script = existingScript ?? document.createElement('script');

    const resolveWhenRuntimeReady = () => {
      const cv = window.cv;
      if (!cv) {
        reject(new Error('OpenCV.js loaded without exposing window.cv.'));
        return;
      }

      if (cv.Mat) {
        resolve({ cv });
        return;
      }

      cv.onRuntimeInitialized = () => {
        resolve({ cv });
      };
    };

    script.onerror = () => {
      openCvPromise = null;
      reject(new Error('Failed to load OpenCV.js.'));
    };
    script.onload = resolveWhenRuntimeReady;

    if (!existingScript) {
      script.src = OPENCV_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.dataset.documentScannerOpencv = 'true';
      document.head.appendChild(script);
    }
  });

  return openCvPromise;
}
