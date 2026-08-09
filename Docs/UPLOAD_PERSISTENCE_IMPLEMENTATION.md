# Durable Upload Implementation

## Incident

The production 18/19 page mismatch was caused by treating a serverless instance's `os.tmpdir()` as shared storage. A successful upload request and a later recognition request can run on different Vercel instances, so their local files are not shared.

## Implemented Contract

1. Each upload batch has a `batchId`, `expectedPageCount`, and one-based `pageNumber`.
2. `POST /api/upload` only returns success after the page has been written to private Vercel Blob storage.
3. Blob paths contain only `jobId`, form type, batch ID, and page number. Original filenames and PII are not used.
4. `POST /api/recognize` receives the two declared batches, reads every expected page from Blob, and materializes them only in a request-scoped scratch directory.
5. A missing stored page returns `UPLOAD_INTEGRITY_ERROR` with expected and available page numbers. It must not be presented as a user page-count mistake.
6. `COUNT_MISMATCH` is reserved for two declared batches with different expected page totals or for a confirmed form-classification split.
7. After the review payload is created, source upload batches are removed. The reset action removes all source uploads for the job.
8. In Vercel, Blob configuration or access failures return a visible storage error. The application never falls back to cross-request local temporary files.

## Required Vercel Setup

- Connect a Vercel Blob store to the project before deployment.
- Confirm the project has private Blob read/write access in Production.
- After deployment, upload the two 19-page PDFs and verify: upload progress 19/19 for both forms, recognition starts, and the review page shows 19 student entries.

## Verification

- `npm test`: 16 files, 63 tests passed. The suite covers durable acknowledgement, overwrite behavior, missing-page integrity errors, selected-form mismatch handling, and source deletion after recognition.
- `npm run build`: passed.
