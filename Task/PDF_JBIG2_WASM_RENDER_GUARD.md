# PDF JBIG2 WASM Rendering Guard

Date: 2026-08-05

## Incident

The batch-upload test with two 19-page scanner PDFs displayed one correction-engine warning for every page. The review page then showed blank source images and blank ROI previews. Opening a school-type ROI produced a mostly black browser background with a small solid-white image, which confirmed that a blank page image had already been uploaded rather than a crop UI problem.

## Evidence and Root Cause

The browser console reported all of the following while PDF.js rendered the scanner PDFs:

- `Jbig2Error: JBig2 failed to initialize`
- `Ensure that the 'wasmUrl' API parameter is provided`
- `Failed to resolve module specifier 'nulljbig2_nowasm_fallback.js'`

The app loaded the PDF.js 6.1.200 viewer bundle and worker from cdnjs, but cdnjs does not publish that version's `/wasm/` decoder files. A direct HTTP check confirmed that its JBIG2 WASM paths return 404. The matching `pdfjs-dist@6.1.200` package on unpkg does publish `wasm/jbig2.wasm` and its fallback modules.

PDF.js could finish the page render promise after that decoder failure with an all-white canvas. The previous implementation converted that canvas to JPEG and uploaded it. Every later recognition and review crop was therefore necessarily empty.

This is a more specific instance of the earlier JBIG2 issue documented in `PDF_BATCH_RENDER_HANG.md`: the earlier timeout guard prevented an endless render, but it did not configure the newly required decoder assets or reject a failed blank render.

## Implementation

1. Added `src/lib/pdf/pdfRenderConfig.ts`.
   - Keeps the PDF.js worker on cdnjs.
   - Passes `wasmUrl: https://unpkg.com/pdfjs-dist@6.1.200/wasm/` to `getDocument` so the worker can initialize the JBIG2 decoder from the exact matching distribution.
2. Added a canvas-content guard after each PDF page render.
   - Uniform/ink-free canvases are rejected before JPEG conversion and before any `/api/upload` call.
   - A page failure now produces a clear upload error instead of a plausible-looking blank review result.
3. Preserved the origin of every batch item.
   - Raster photos can still use the perspective-correction worker.
   - Images extracted from scanner PDFs bypass perspective correction because they are already planar. An unavailable correction worker therefore cannot generate one warning per PDF page.
4. Added unit coverage for the decoder configuration and blank-canvas guard.

## Scope Separation

The blank PDF images and the direct-phone-photo coordinate drift are separate problems. This change fixes the former and makes it impossible for that failure mode to silently enter review. Direct phone photos still use guarded table-cell registration and stay manual-review-only when their cells cannot be located with sufficient certainty. The next accuracy iteration should refine each response row locally rather than applying one global registration transform to all rows.

## Deployment Verification

Use the same two 19-page PDFs after deployment.

1. The batch step must not show the correction-engine-unavailable warning for PDF pages.
2. DevTools must not show `wasmUrl`, `nulljbig2_nowasm_fallback.js`, or `JBig2 failed to initialize` messages.
3. The review page's two original-image previews must show page content.
4. Opening a school-type or answer ROI must show form ink and table cells, not a solid-white rectangle.
5. If a decoder still fails, upload must stop with the page-numbered error; it must not create a blank draft.
