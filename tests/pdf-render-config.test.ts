import { describe, expect, it } from 'vitest';

import {
  PDFJS_WASM_URL,
  PDFJS_WORKER_SRC,
  buildPdfDocumentOptions,
  hasMeaningfulRenderedPixels,
} from '../src/lib/pdf/pdfRenderConfig';

describe('PDF render configuration', () => {
  it('provides a decoder WASM path alongside the same-version worker', () => {
    const data = new ArrayBuffer(12);

    expect(PDFJS_WORKER_SRC).toContain('pdf.js/6.1.200/pdf.worker.min.mjs');
    expect(PDFJS_WASM_URL).toBe('https://unpkg.com/pdfjs-dist@6.1.200/wasm/');
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
