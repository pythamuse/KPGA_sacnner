# Grid-Cell Recognition Implementation Record

Date: 2026-08-05

## Delivered

- Added table-rule detection for CAGI and satisfaction response blocks.
- Added a guarded fallback that registers repeated printed answer circles when a tilted phone photo makes one table rule drift across rows.
- Added detected cell rectangles to recognition scoring and to the review-crop generator.
- Fixed EXIF orientation handling. Pixel dimensions now come from Sharp's post-rotation raw output, rather than pre-rotation JPEG metadata.
- Changed detected-cell review crops to use cell-relative padding, preventing adjacent questions from appearing in the same crop.

## Safety Policy

- Exact table-cell grids retain the existing strict automatic-selection threshold; the grid does not lower that threshold.
- Circle-pattern registration is used only to place review crops for CAGI. It intentionally leaves the answer at low confidence for manual confirmation.
- If the document frame is not trustworthy, neither grid nor registration is used to auto-confirm a value.

## Verification

- Synthetic tests cover horizontal/vertical grid line grouping, stale static ROI coordinates, EXIF orientation 6, and pixel-cell crop padding.
- The supplied phone-photo pair was diagnosed locally after the EXIF fix. CAGI questions 1-9 and satisfaction questions 1-6 now produce detected review-cell coordinates.
- The CAGI sample's first response review crop was visually checked: it contains one response row and its four choices.

## Next Validation

1. Test the deployed version with the same two photos and confirm that review crops line up with each question.
2. Collect at least 30 labelled samples before allowing registered CAGI circles to auto-confirm answers.
3. Benchmark PaddleOCR plus SLANeXt_wired or Table Transformer in a separate service only if table-grid registration remains insufficient.
