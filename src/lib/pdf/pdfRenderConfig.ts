export const PDFJS_VERSION = '6.1.200';

const PDFJS_CDN_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
const PDFJS_DIST_BASE = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}`;

export const PDFJS_WORKER_SRC = `${PDFJS_CDN_BASE}/pdf.worker.min.mjs`;
// cdnjs publishes the viewer and worker bundle, but not the decoder WASM assets.
// JBIG2 scanner PDFs require these assets to initialize their decoder.
export const PDFJS_WASM_URL = `${PDFJS_DIST_BASE}/wasm/`;

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
