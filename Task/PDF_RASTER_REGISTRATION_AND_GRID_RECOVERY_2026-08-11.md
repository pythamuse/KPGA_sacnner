# PDF Raster Registration and Grid Recovery (2026-08-11)

## Scope

This note records the regression found with the user-provided 19-page CAGI and
satisfaction PDFs. The original PDFs are personal test material and are not
added to the repository. Reproduction uses the same browser-side PDF.js raster
conditions: 1.5x page rendering followed by JPEG conversion.

## Root Causes

1. The upload flow treated PDF pages as camera photos and sent all 38 rendered
   pages to the browser-only perspective correction Worker. A PDF.js page is
   already a flat rectangular raster, so an unavailable Worker generated one
   misleading warning per page without improving registration.
2. Form classification used a raw paper envelope, while recognition used the
   measured blank-form registration frame. The two coordinate systems could
   score the same flat satisfaction page against different anchors.
3. Thin printed outer rules can be weak after scan/JPEG conversion. The
   satisfaction binary table kept its inner vertical rule, and the scale table
   kept four inner vertical rules, but one or both outer rules were missing.
   The CAGI 8-9 table kept two true horizontal boundaries while its interior
   boundary was faint; a nearby explanation divider was incorrectly eligible
   under a page-wide tolerance.

## Implementation

- `perspectiveCorrectionPolicy.ts` makes camera/direct image uploads the only
  candidate for browser perspective correction. PDF pages proceed directly to
  server-side template registration.
- `classifyForm.ts` registers the image separately for the CAGI and
  satisfaction templates before scoring their signatures.
- `tableGridDetection.ts` can infer a missing table rule only from a locally
  consistent affine pattern. It requires at least two measured rules, a scale
  within 15%, bounded translation, matching choice centers, and the existing
  verified-grid checks.
- The partial-pattern tolerance is based on the table span instead of the full
  page. This prevents the CAGI Q8/Q9 explanation divider from being accepted
  as a missing row boundary.

## Safety Rules

1. A full measured grid remains preferred over inferred rules.
2. If a large table has a complete but mismatched line set, keep it manual;
   do not substitute a guessed grid.
3. An inferred grid still has to pass the same response-mark confidence checks
   before it can write an answer.
4. Basic fields remain manual when their row and column geometry cannot be
   independently verified. A blank age OCR result must not become a guessed
   age.

## Regression Tests

- `tests/perspective-correction-policy.test.ts` proves PDF pages do not warm
  or call the camera-only correction path.
- `tests/form-classifier.test.ts` proves template-frame classification for
  flat registered pages.
- `tests/table-grid-detection.test.ts` covers missing satisfaction outer
  vertical rules and a missing CAGI internal horizontal rule.

## Observed Browser-Like Result

On the same first pages, CAGI Q1-Q9 and satisfaction Q1-Q10 reach verified
grid registration. The behavior is deliberately conservative for basic
metadata and does not invent a handwritten age.
