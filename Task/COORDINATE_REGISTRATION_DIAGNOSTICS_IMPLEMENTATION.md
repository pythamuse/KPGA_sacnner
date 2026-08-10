# Coordinate Registration Diagnostics and Safeguards

Date: 2026-08-10

## Purpose

The review screen repeatedly showed a response ROI that did not match the
question cell in the source image. The target is not to make an uncertain crop
look plausible. The target is to identify the coordinate source, block unsafe
automatic values, and leave enough evidence to diagnose the next failed test.

The blank-form measurement in
`Task/BLANK_FORM_GROUND_TRUTH_MEASUREMENT.md` is the source of truth for the
printed form geometry. Do not edit that document or alter its fixtures while
testing recognition behaviour.

## Confirmed Causes

### 1. Template anchor mismatch

The initial CAGI option X anchors were several percent to the right of the
measured blank form. CAGI questions 1-7 and 8-9 have slightly different
printed column geometry, so they now use separate measured X anchors.

### 2. A visible rule is not proof of the correct table

Printed text, option circles, handwriting, and table borders can all create
dark-pixel projections. A detector that only finds enough horizontal and
vertical lines may lock onto the wrong grid. A candidate grid must therefore
be checked against the expected gap pattern, residual, option-cell offsets,
intra-table consistency, and cross-table consistency.

### 3. Display and scoring coordinates diverged

An unverified grid candidate was visible in the review card but was not always
used by the scorer. In those cases the score came from a normalized template
area while the ROI showed a different candidate table. That made the displayed
evidence impossible to interpret.

Candidate cells now drive manual candidate scoring when their row gap,
residual, and center measurements are stable. A broad row matcher is not
automatically considered stronger than that local grid evidence. When grid row
measurements are unstable, a row match can supply Y bounds paired with the
candidate grid's observed X columns. This hybrid is manual-only and the raw
grid remains visible as rejected evidence.

### 4. A two-row table can match any line pair

For a two-row group, relative-gap matching sees only one gap. Any two nearby
horizontal rules can therefore look structurally valid. On the supplied scan,
an earlier pair of printed lines was selected for CAGI questions 8 and 9.

Row matching now compares each eligible line sequence with the expected form
position inside a usable content envelope. It allows one consistent translation
between response centers and printed rules, but rejects sequences with an
incorrect span, excessive offset, or uneven residual.

### 5. Frame confidence is not the same as an unusable coordinate envelope

The local replay of the supplied batch PDF reported a non-confident outer frame
because the scanner did not preserve one continuous page border. Its detected
content envelope still covered the complete form and matched the expected page
aspect ratio. Treating that envelope as the full bitmap shifted late CAGI row
searches upward and allowed an unrelated line pair to compete.

The row matcher now uses any usable form envelope, regardless of the separate
frame-confidence flag. A regression fixture covers this distinction. The
private replay also confirmed that the CAGI candidate grids had stable row
measurements; their manual candidate scores now use the same cells shown in
the review ROI.

### 6. Wide-band slope tolerance is a false-correction path

A private local diagnostic was run against the supplied real photos without
copying them into the repository. CAGI preserved a coherent grid with an
approximately uniform horizontal translation. The satisfaction photo had
perspective distortion, printed text, and check marks that polluted the
projection detector.

Increasing the line-band radius made the detector join text and marks into
false table rules. That experiment has been removed from automatic table
registration. More tolerant projections are not a substitute for document
perspective correction.

## Implemented Safeguards

1. Each field receives a `FieldRegistration` record with a table ID, source,
   status (`verified`, `candidate`, or `failed`), line counts, gap/residual
   values, scale/offset values, and a diagnostic string.
2. Only a `verified` grid may produce an automatic response value. It must
   also pass the existing high-confidence visual mark threshold.
3. A candidate grid whose row measurements are stable is the preferred source
   for manual scoring and the visible ROI, even if its columns need review.
4. If those grid row measurements are unstable, `row-fallback` uses detected
   grid columns plus anchor-verified row bounds. Both paths remain manual-only.
5. Basic-information row candidates are scored from their row-derived cells
   as suggestions only; their independent column geometry is not considered
   verified.
6. The debug ROI distinguishes evidence:
   * solid colored boxes: cells used for scoring;
   * orange dashed boxes: a rejected grid candidate;
   * red rectangle: the union used for the cropped review image.
7. The review page includes a collapsible `Coordinate diagnostics` section.
   It exposes table ID, status, detected line counts, gap/residual values, and
   coordinate offset/spread for each field without exposing personal data.

## Test Evidence

The following automated checks must pass before a coordinate change is
considered safe:

| Test | What it proves |
| --- | --- |
| Blank form regression | CAGI 1-9 and satisfaction 1-10 resolve to measured rows and columns. |
| CAGI anchor regression | Questions 1-7 and 8-9 retain their separate measured X geometry. |
| Verified-grid recognition | Strong marks on a verified grid can be written automatically. |
| Uniform-translation grid | A coherent local grid may be verified even if the overall content bound is translated. |
| Candidate-grid safety | A distorted grid remains a review candidate and cannot write a response automatically. |
| Row-fallback route | An unstable grid does not prevent an anchor-verified row from providing the scoring and review cells. |
| Two-row anchor regression | A short distractor line pair cannot replace CAGI questions 8-9. |
| Usable-envelope regression | A complete scanner envelope remains a valid template frame without a detected outer border. |
| No-frame safety | A missing document frame never turns template-only coordinates into automatic values. |

Private scans and local test images must not be committed. The private
diagnostic is deliberately removed after use; only its anonymized numerical
conclusions belong in this document.

## Next Test Procedure

For the next deployed test, capture only the following information:

1. The page test version.
2. The affected field card with its source badge.
3. The enlarged `ROI confirmation` image.
4. The matching row in the expanded `Coordinate diagnostics` section.

This makes each outcome classifiable without sharing a full source scan:

| Observed state | Meaning | Next action |
| --- | --- | --- |
| `grid verified` but wrong cells | Incorrect template/line matching regression. Compare measured anchors and selected rules. |
| `grid candidate` | Grid evidence exists but fails geometry validation. Keep manual and inspect gap/residual/offset. |
| `row-fallback` | Grid row geometry was unstable; evaluate the solid fallback cells, not the dashed grid boxes. |
| `row` | Only row geometry was usable. Improve row matching only after verifying the source row. |
| `fixed` | Neither table nor row geometry is reliable. Do not add a static offset workaround. |

## Direction for Perspective-Distorted Photos

The next recognition improvement must use a document-level transformation,
not looser projection thresholds. The existing client-side perspective
correction is the appropriate first stage for camera images. Batch PDF pages
must preserve their rendered scan geometry and be diagnosed per page. A future
server-side correction path must be accepted only when it can prove the outer
document quadrilateral and improve both table-rule continuity and selected-cell
accuracy on a private regression set.

Until that proof exists, uncertain coordinates remain review-only. Response
frequency priors may rank low-confidence suggestions but must never convert a
failed registration into an automatic answer.
