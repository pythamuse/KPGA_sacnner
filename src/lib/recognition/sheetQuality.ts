import { applyTemplateRegistrationFrame, loadImageAnalysisData } from './markDensity';
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
 * sample. gridFields / pageInkRatio / pageIsBinarySource / contentBounds*
 * stay in `signals` as REPORTED VALUES ONLY — measured at chance-level
 * separation (T3 2026-08-27); do not add thresholds on these without new
 * evidence. See spec F3.4.
 */

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
    && typeof candidate.verified === 'boolean';
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

  const registration = input.registration ?? null;
  const signals: SheetQualitySignals = {
    width: image.width,
    height: image.height,
    pageInkRatio: image.pageInkRatio ?? 0,
    pageIsBinarySource: image.pageIsBinarySource ?? false,
    gridFields: Object.keys(grid.overrides).length,
    contentBoundsSource: image.contentBoundsSource ?? 'none',
    contentBoundsConfident: image.contentBoundsConfident,
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

  return {
    verdict: 'good',
    signals,
    reasons: [REASON_REGISTRATION_VERIFIED],
    hints: [],
  };
}
