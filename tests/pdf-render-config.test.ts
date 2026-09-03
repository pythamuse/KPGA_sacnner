import { describe, expect, it } from 'vitest';

import {
  PDFJS_MAIN_SRC,
  PDFJS_VERSION,
  PDFJS_WASM_URL,
  PDFJS_WORKER_SRC,
  buildPdfDocumentOptions,
  hasMeaningfulRenderedPixels,
} from '../src/lib/pdf/pdfRenderConfig';

describe('PDF render configuration', () => {
  it('keeps every PDF.js runtime URL on the same-origin vendor path', () => {
    const data = new ArrayBuffer(12);
    const urls = [PDFJS_MAIN_SRC, PDFJS_WORKER_SRC, PDFJS_WASM_URL];

    expect(PDFJS_MAIN_SRC).toBe(`/vendor/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`);
    expect(PDFJS_WORKER_SRC).toBe(`/vendor/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`);
    expect(PDFJS_WASM_URL).toBe(`/vendor/pdfjs/${PDFJS_VERSION}/wasm/`);
    for (const url of urls) {
      expect(url).toMatch(/^\/vendor\//);
      expect(url).not.toMatch(/^https?:\/\//);
      expect(url).not.toContain('cdnjs.cloudflare.com');
      expect(url).not.toContain('unpkg.com');
      expect(url).not.toContain('docs.opencv.org');
    }
    expect(buildPdfDocumentOptions(data)).toEqual({ data, wasmUrl: PDFJS_WASM_URL });
  });

  it('rejects uniform canvases but accepts a rendered document with ink', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(255);
    const rendered = new Uint8ClampedArray(blank);

    for (let y = 20; y < 80; y += 4) {
      for (let x = 15; x < 85; x += 3) {
        const offset = (y * 100 + x) * 4;
        rendered[offset] = 30;
        rendered[offset + 1] = 30;
        rendered[offset + 2] = 30;
      }
    }

    expect(hasMeaningfulRenderedPixels(blank, 100, 100)).toBe(false);
    expect(hasMeaningfulRenderedPixels(rendered, 100, 100)).toBe(true);
  });
});
