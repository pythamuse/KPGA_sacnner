import { applyTemplateRegistrationFrame, loadImageAnalysisData } from './markDensity';
import { measureSheetExposureForImage, type SheetExposureMeasurement } from './sheetExposure';
import { buildCagiGridDetection, buildSatisfactionGridDetection } from './tableGridDetection';
import { cagiTemplate, satisfactionTemplate, type FormType } from './roiTemplates';

/**
 * Sheet-level quality verdict (spec F3, Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md).
 *
 * This module is read-only: it measures an uploaded sheet with the SAME
 * building blocks recognition uses and interprets the result for the
 * reviewer. It never mutates the image, never touches recognition gates or
 * thresholds, and never changes a recognized value (F3.3: the verdict is a
 * signal for people, not a gate relaxation).
 */

/**
 * Structural copy of F1's RegistrationMeta (spec F1.2).
 *
 * Track T1 defines the canonical type in src/lib/documentScanner/* in a
 * parallel worktree; importing from there now would race that work. This
 * local declaration is structurally compatible on purpose — unify the two
 * into one exported type when T1 and T2 merge.
 */
export interface RegistrationMetaLike {
  method: 'quad' | 'orb' | 'none';
  confidence: number;
  orbInliers: number;
  orbInlierRatio: number;
  quadResidualPx: number | null;
  rejection: string | null;
  verified: boolean;
  /**
   * The user explicitly chose "use as-is" past a retake prompt (spec F2.3).
   * Travels into `signals.registration` so the review screen can tell an
   * overridden sheet from one the pipeline accepted; it never changes the
   * verdict — an unregistered sheet stays `unusable` whether or not someone
   * insisted on uploading it.
   */
  overridden?: boolean;
}

export interface SheetQualitySignals {
  width: number;
  height: number;
  pageInkRatio: number;
  pageIsBinarySource: boolean;
  /** buildGridDetection field count (0~13). Reported only — see T3 note. */
  gridFields: number;
  contentBoundsSource: string;
  contentBoundsConfident: boolean;
  /**
   * Sheet-level exposure against the blank template (src/lib/recognition/
   * sheetExposure.ts). Reported only, like everything above it — see the T3
   * comment block below, and the DISABLED threshold beneath that.
   *
   * Null when the blank asset could not be read; a figure with no reference
   * would be a different measurement wearing this one's name.
   */
  exposure: SheetExposureMeasurement | null;
  registration: RegistrationMetaLike | null;
}

export interface SheetQualityVerdict {
  verdict: 'good' | 'retake-suggested' | 'unusable';
  signals: SheetQualitySignals;
  /** Machine-readable verdict grounds. */
  reasons: string[];
  /** User-facing Korean strings, verbatim from spec F2.2 so F2 and F3 never disagree in wording. */
  hints: string[];
}

/*
 * T3 2026-08-27 — why the verdict uses ONLY registration meta.
 *
 * Central measurement (T3, against the 19-student answer key, which this
 * worktree does not have) tested the draft F3.2 bands: best single-threshold
 * separation of productive vs unproductive students, versus a 500-permutation
 * shuffled-label control (p95):
 *
 *   gridFields    14/19 correct vs control 14  -> chance level
 *   orbInliers    13    vs control 15          -> below chance
 *   pageInkRatio  16    vs control 15          -> marginal AND
 *                 direction-inverted: productive students had HIGHER ink
 *                 (0.56~0.61) than most unproductive ones. The draft rule
 *                 "pageInkRatio > 0.55 -> retake" would have flagged the
 *                 GOOD batch.
 *
 * Conclusion: sheet-level image signals cannot cut good/retake bands on this
 * sample. gridFields / pageInkRatio / pageIsBinarySource / contentBounds* /
 * exposure stay in `signals` as REPORTED VALUES ONLY — the first four were
 * measured at chance-level separation (T3 2026-08-27) and the fifth has not
 * been measured against labels at all yet; do not add thresholds on any of
 * them without new evidence. See spec F3.4.
 *
 * W-B 2026-08-27 — why `exposure` is here and still reported-only.
 *
 * `signals.exposure` is a different KIND of signal from the four T3 rejected:
 * those are computed from the sheet alone, while exposure is a comparison
 * against the blank TEMPLATE. Spec §12.2 measured its cell-level ancestor
 * (`brightnessOffset`) reaching 185 on zero-yield sheets against at most 61
 * among productive ones — a tail that looks like it might forecast, at upload
 * time, a sheet that will yield nothing.
 *
 * "Looks like" is the whole of the evidence so far. The medians nearly touch
 * (44 vs 39), only the tail separates, and this worktree has no labels. T3 is
 * the standing warning: pageInkRatio also looked separable and turned out to
 * be marginal AND inverted. So the measurement ships and the threshold does
 * not.
 */

// Machine reason code for the DISABLED exposure rule below. Defined next to
// the rule so an enabled threshold has nothing left to invent.
const REASON_EXPOSURE_UNDEREXPOSED = 'exposure-underexposed';

/**
 * PROVISIONAL user-facing hint for the DISABLED exposure rule.
 *
 * Not in spec F2.2's wording table, because F2.2's table is what the retake UI
 * implements and this rule cannot fire. Whoever enables the threshold adds the
 * row to F2.2 first, so the two features still cannot disagree in wording.
 */
const HINT_UNDEREXPOSED = '사진이 어두워 표기가 보이지 않을 수 있습니다. 밝은 곳에서 다시 찍어주세요';

/**
 * ==== INACTIVE — exposure threshold, deliberately disabled (W-B 2026-08-27) ====
 *
 * `null` disables `exposureRetakeReason` outright, so today every verdict is
 * the registration-only verdict and nothing below this line can change one.
 * tests/sheet-exposure.test.ts pins both halves of that: the constant is null,
 * and the verdicts are identical with the exposure signal present.
 *
 * THE CENTRAL CHECKOUT ENABLES THIS ONLY IF A SHUFFLED-LABEL CONTROL CLEARS
 * IT. The procedure is the one that rejected T3's bands (spec F3.4): score the
 * best single cut of `offset82` over the labelled photo set, compare it with
 * the p95 of 500 shuffled-label permutations, and set a number here only if
 * the real cut beats that control. A cut that merely looks good on 19 sheets
 * is what T3 already caught. Run:
 *
 *   node scripts/report-sheet-exposure.cjs <photo-dir>
 *
 * Setting a number here can only ever move a sheet from 'good' to
 * 'retake-suggested' — it admits no value, relaxes no gate, and touches no
 * recognition threshold (spec F3.3, and the WRONG = 0 ordering).
 */
const EXPOSURE_OFFSET82_RETAKE_THRESHOLD: number | null = null;

/**
 * The inactive rule itself, as a function so it is a real code path rather
 * than a comment describing one.
 *
 * Exported for the test that proves a null threshold silences it whatever the
 * exposure is.
 */
export function exposureRetakeReason(
  exposure: SheetExposureMeasurement | null,
  threshold: number | null = EXPOSURE_OFFSET82_RETAKE_THRESHOLD,
): string | null {
  if (threshold === null || !exposure) {
    return null;
  }
  return exposure.offset82 >= threshold ? REASON_EXPOSURE_UNDEREXPOSED : null;
}

/** Read by the test that fails the moment someone enables this locally. */
export function getExposureRetakeThreshold(): number | null {
  return EXPOSURE_OFFSET82_RETAKE_THRESHOLD;
}

// Machine reason codes (spec F3.2: `reasons`).
const REASON_REGISTRATION_NONE = 'registration-none';
const REASON_UNVERIFIED_WARP = 'unverified-warp';
const REASON_REGISTRATION_VERIFIED = 'registration-verified';
const REASON_NO_REGISTRATION_META = 'no-registration-meta';

// User-facing hints, verbatim from spec F2.2's table (do not reword here —
// F2's retake UI uses the same table, and the two features must never
// disagree in wording).
const HINT_PAPER_NOT_FOUND = '종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요';
const HINT_CROPPED = '종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요';
const HINT_TOO_SMALL = '종이가 화면을 더 채우도록 가까이서 찍어주세요';
const HINT_WRONG_SHAPE = '종이 정면에서, 세로 방향으로 찍어주세요';
const HINT_UNVERIFIED = '촬영 상태가 좋지 않아 인식 정확도가 낮을 수 있습니다. 다시 찍는 것을 권장합니다';

const REJECTION_HINTS: Record<string, string> = {
  cropped: HINT_CROPPED,
  'too-small': HINT_TOO_SMALL,
  'wrong-shape': HINT_WRONG_SHAPE,
};

export interface SheetQualityInput {
  imagePath: string;
  formType: FormType;
  registration?: RegistrationMetaLike | null;
}

/** Runtime validator for registration meta arriving over the API boundary. */
export function isRegistrationMetaLike(value: unknown): value is RegistrationMetaLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RegistrationMetaLike>;
  return (candidate.method === 'quad' || candidate.method === 'orb' || candidate.method === 'none')
    && typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
    && typeof candidate.orbInliers === 'number' && Number.isFinite(candidate.orbInliers)
    && typeof candidate.orbInlierRatio === 'number' && Number.isFinite(candidate.orbInlierRatio)
    && (candidate.quadResidualPx === null
      || (typeof candidate.quadResidualPx === 'number' && Number.isFinite(candidate.quadResidualPx)))
    && (candidate.rejection === null || typeof candidate.rejection === 'string')
    && typeof candidate.verified === 'boolean'
    && (candidate.overridden === undefined || typeof candidate.overridden === 'boolean');
}

/**
 * Measures one uploaded sheet and interprets the capture metadata.
 *
 * The measurement path is exactly recognition's own: load once, register to
 * the blank template's frame, run the matching grid detection. The verdict
 * itself uses only the F1 registration meta (T3 2026-08-27, comment block
 * above); the image measurements ride along as `signals` for the reviewer
 * and for later analysis.
 */
export async function evaluateSheetQuality(input: SheetQualityInput): Promise<SheetQualityVerdict> {
  const template = input.formType === 'cagi' ? cagiTemplate : satisfactionTemplate;
  const image = applyTemplateRegistrationFrame(
    await loadImageAnalysisData(input.imagePath),
    template.registrationFrame,
  );
  const grid = input.formType === 'cagi'
    ? buildCagiGridDetection(image)
    : buildSatisfactionGridDetection(image);
  // Measured from the image already in hand, against the same blank the
  // scorer subtracts. Reported only — see the comment block above.
  const exposure = await measureSheetExposureForImage(image, input.formType);

  const registration = input.registration ?? null;
  const signals: SheetQualitySignals = {
    width: image.width,
    height: image.height,
    pageInkRatio: image.pageInkRatio ?? 0,
    pageIsBinarySource: image.pageIsBinarySource ?? false,
    gridFields: Object.keys(grid.overrides).length,
    contentBoundsSource: image.contentBoundsSource ?? 'none',
    contentBoundsConfident: image.contentBoundsConfident,
    exposure,
    registration,
  };

  // Verdict rules (spec F3.2 as corrected by F3.4 / T3 2026-08-27):
  // registration meta only. No image-signal thresholds — see comment block.
  if (!registration) {
    // Scan/PDF path and legacy uploads carry no F1 meta. A scan must never
    // be told to retake, so unknown provenance reads as good.
    return {
      verdict: 'good',
      signals,
      reasons: [REASON_NO_REGISTRATION_META],
      hints: [],
    };
  }

  if (registration.method === 'none') {
    const rejectionHint = (registration.rejection && REJECTION_HINTS[registration.rejection])
      // `rejection: null` means the paper itself was never found; unknown
      // rejection codes fall back to the same generic re-shoot instruction.
      || HINT_PAPER_NOT_FOUND;
    return {
      verdict: 'unusable',
      signals,
      reasons: [REASON_REGISTRATION_NONE],
      hints: [rejectionHint],
    };
  }

  if (!registration.verified) {
    return {
      verdict: 'retake-suggested',
      signals,
      reasons: [REASON_UNVERIFIED_WARP],
      hints: [HINT_UNVERIFIED],
    };
  }

  // ==== INACTIVE while EXPOSURE_OFFSET82_RETAKE_THRESHOLD is null ====
  // `exposureRetakeReason` returns null unconditionally today, so this branch
  // is unreachable and the verdict below is the one this function has always
  // returned. Placed last on purpose: it can only ever turn a 'good' into a
  // 'retake-suggested', never soften 'unusable' or 'retake-suggested', and it
  // sits AFTER the no-registration return above so a scan — which carries no
  // capture metadata — can never be told to retake (spec F3.2).
  const exposureReason = exposureRetakeReason(signals.exposure);
  if (exposureReason) {
    return {
      verdict: 'retake-suggested',
      signals,
      reasons: [exposureReason],
      hints: [HINT_UNDEREXPOSED],
    };
  }

  return {
    verdict: 'good',
    signals,
    reasons: [REASON_REGISTRATION_VERIFIED],
    hints: [],
  };
}
