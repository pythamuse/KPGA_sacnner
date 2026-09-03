export const PDFJS_VERSION = '6.1.200';

const PDFJS_VENDOR_BASE = `/vendor/pdfjs/${PDFJS_VERSION}`;

export const PDFJS_MAIN_SRC = `${PDFJS_VENDOR_BASE}/pdf.min.mjs`;
export const PDFJS_WORKER_SRC = `${PDFJS_VENDOR_BASE}/pdf.worker.min.mjs`;
// JBIG2 scanner PDFs require these matching decoder assets to initialize.
export const PDFJS_WASM_URL = `${PDFJS_VENDOR_BASE}/wasm/`;

/**
 * Upload raster settings. The browser renders every PDF page through this
 * ladder and uploads JPEG, so the recognition layer never sees a lossless
 * page. `tests/real-scan-measure.test.ts` imports the same values: when the
 * harness rendered at scale 2.0 PNG instead, it measured CORRECT 116/135
 * WRONG 0 on the exact commit where the deployed setting measured
 * CORRECT 92/135 WRONG 1. Keep the two bound to one source.
 */
export const MAX_UPLOAD_IMAGE_BYTES = 3.8 * 1024 * 1024;

export interface PdfRenderOption {
  scale: number;
  quality: number;
}

export const PDF_RENDER_OPTIONS: PdfRenderOption[] = [
  { scale: 1.5, quality: 0.86 },
  { scale: 1.25, quality: 0.82 },
  { scale: 1.0, quality: 0.78 },
];

export const IMAGE_SHRINK_OPTIONS: PdfRenderOption[] = [
  { scale: 1.0, quality: 0.86 },
  { scale: 0.85, quality: 0.82 },
  { scale: 0.7, quality: 0.78 },
  { scale: 0.55, quality: 0.74 },
];

export interface PdfDocumentOptions {
  data: ArrayBuffer;
  wasmUrl: string;
}

export function buildPdfDocumentOptions(data: ArrayBuffer): PdfDocumentOptions {
  return {
    data,
    wasmUrl: PDFJS_WASM_URL,
  };
}

/**
 * PDF.js can resolve a render after a failed image decode and leave a uniform
 * canvas behind. Reject only pages with no meaningful ink, so a blank page is
 * never stored as a source document or used for ROI extraction.
 */
export function hasMeaningfulRenderedPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  if (width < 1 || height < 1 || pixels.length < width * height * 4) {
    return false;
  }

  const targetSamples = 24_000;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / targetSamples)));
  let sampled = 0;
  let darkPixels = 0;
  let nonWhitePixels = 0;
  let minValue = 255;
  let maxValue = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const value = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
      sampled++;
      minValue = Math.min(minValue, value);
      maxValue = Math.max(maxValue, value);

      if (value < 245) nonWhitePixels++;
      if (value < 210) darkPixels++;
    }
  }

  if (sampled === 0 || maxValue - minValue < 8) {
    return false;
  }

  return nonWhitePixels >= 24 && darkPixels >= 6;
}
