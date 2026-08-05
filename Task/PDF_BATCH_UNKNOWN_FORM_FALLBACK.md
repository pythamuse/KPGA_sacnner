# PDF Batch Unknown Form Fallback

Date: 2026-08-05

## Reproduction

The supplied `선별검사 샘플1.pdf` and `만족도조사1.pdf` are both EPSON Scan A4 PDFs with 19 pages. Poppler rendered 19 non-empty JPEG pages from each file. After the browser upload, however, the recognition API returned `COUNT_MISMATCH` with CAGI 18 and satisfaction 19.

## Root Cause

This was not a PDF page-count or upload-count failure. The recognition API classified every uploaded image before pairing it. If a page's image-content classifier returned `unknown`, the old code used that value as the effective type and added the page to neither list. The filename still showed that the user had uploaded the page in the CAGI slot, but that evidence was discarded.

Scanner PDFs can produce a lower-contrast page that is difficult to classify even when it is a valid form. A classification result of `unknown` means "not enough evidence", not "wrong form". Dropping it caused the false page-count mismatch.

## Policy and Implementation

1. A confident content classification that conflicts with the selected upload slot still raises `FORM_TYPE_MISMATCH` and requires explicit confirmation.
2. An `unknown` content classification now retains the user's selected slot (`cagi_` or `satisfaction_` filename prefix).
3. The classifier policy version is `2026-08-05.5` and the visible test marker is `v2026-08-05.8`.
4. A regression test creates two blank, unclassifiable pages in separate upload slots and verifies that recognition pairs them rather than reporting a count mismatch.

## Verification

Local verification used all 38 pages rendered from the supplied two PDFs. Both PDF files reported 19 pages and the recognition API produced 19 paired drafts successfully.

Retest the same two 19-page PDFs after deployment. The API must either produce 19 paired drafts or report a specific confident form mismatch. It must not report CAGI 18 versus satisfaction 19 merely because a page is `unknown`.
