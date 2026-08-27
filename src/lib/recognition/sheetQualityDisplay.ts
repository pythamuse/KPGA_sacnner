/**
 * Review-screen presentation of the per-sheet quality verdicts (spec F3).
 *
 * This module is deliberately free of any server import. `sheetQuality.ts`
 * pulls in `sharp` through `markDensity`, and the review screen is a client
 * component, so the shape is declared structurally here — the same approach
 * `RecognitionMeasurementsByField` takes in `../labelExport/types`. The
 * compile-time check that this declaration still accepts a real
 * `SheetQualityVerdict` lives in tests/review-snapshot.test.ts, so drift
 * fails `tsc --noEmit` instead of failing silently in the browser.
 *
 * Display only: nothing here reads or changes a recognized value, a gate, or
 * a threshold (spec F3.3).
 */

export type SheetQualityLevel = 'good' | 'retake-suggested' | 'unusable';

export type SheetQualitySide = 'cagi' | 'satisfaction';

/** Structural copy of `SheetQualityVerdict` (src/lib/recognition/sheetQuality.ts). */
export interface SheetQualityVerdictLike {
  verdict: SheetQualityLevel;
  reasons?: string[];
  hints?: string[];
  signals?: {
    registration?: { overridden?: boolean } | null;
  } | null;
}

/** What `/api/recognize` attaches to a student draft (route.ts buildSheetQualityAttachment). */
export type SheetQualityAttachment = {
  [side in SheetQualitySide]?: SheetQualityVerdictLike;
};

export interface SheetQualityBadge {
  side: SheetQualitySide;
  /** '선별검사지' / '만족도조사' — the same names the upload panel uses. */
  sideLabel: string;
  level: SheetQualityLevel;
  /** Badge text including the override marker, ready to render. */
  label: string;
  /** The user explicitly proceeded past a retake prompt (spec F2.3). */
  overridden: boolean;
  /** First user-facing hint, or null when the verdict carries none. */
  hint: string | null;
}

export const SHEET_SIDE_LABELS: Record<SheetQualitySide, string> = {
  cagi: '선별검사지',
  satisfaction: '만족도조사',
};

/**
 * Verdict wording, identical to the upload panel's strip
 * (src/components/ImageUploadPanel.tsx). One verdict must not be called two
 * different things depending on which screen the reviewer is looking at.
 */
export const SHEET_VERDICT_LABELS: Record<SheetQualityLevel, string> = {
  good: '정상',
  'retake-suggested': '재촬영 권장',
  unusable: '인식 불가 우려',
};

/** Appended when the sheet was uploaded past an explicit retake prompt. */
export const SHEET_OVERRIDE_SUFFIX = ' · 사용자 강행';

/** `reasons` code meaning "this sheet arrived without F1 capture metadata". */
const REASON_NO_REGISTRATION_META = 'no-registration-meta';

const SIDE_ORDER: SheetQualitySide[] = ['cagi', 'satisfaction'];

/**
 * True when the verdict is not a judgement about the capture at all.
 *
 * A scanned PDF and any draft made before F1 existed carry no
 * `RegistrationMeta`, and `evaluateSheetQuality` answers 'good' for those on
 * purpose — a scan must never be told to retake. Rendering that as "정상"
 * would tell the reviewer the sheet was checked and passed, when in fact
 * nothing was measured. Absence must not look like a verdict, so these are
 * dropped from the strip.
 */
function isProvenanceUnknown(verdict: SheetQualityVerdictLike): boolean {
  const hasHints = Array.isArray(verdict.hints) && verdict.hints.length > 0;
  const hasRegistration = Boolean(verdict.signals?.registration);
  const saysUnknown = Array.isArray(verdict.reasons)
    && verdict.reasons.includes(REASON_NO_REGISTRATION_META);

  return saysUnknown && !hasHints && !hasRegistration;
}

/**
 * Turns the draft's `sheetQuality` attachment into the badges the review strip
 * renders, in a fixed side order. Returns an empty list whenever there is
 * nothing to say — no attachment, an empty attachment, or only
 * provenance-unknown verdicts — and the strip renders nothing at all.
 */
export function buildSheetQualityBadges(
  attachment: SheetQualityAttachment | null | undefined,
): SheetQualityBadge[] {
  if (!attachment) return [];

  const badges: SheetQualityBadge[] = [];
  for (const side of SIDE_ORDER) {
    const verdict = attachment[side];
    if (!verdict || !SHEET_VERDICT_LABELS[verdict.verdict]) continue;
    if (isProvenanceUnknown(verdict)) continue;

    const overridden = verdict.signals?.registration?.overridden === true;
    const hints = Array.isArray(verdict.hints) ? verdict.hints : [];

    badges.push({
      side,
      sideLabel: SHEET_SIDE_LABELS[side],
      level: verdict.verdict,
      label: `${SHEET_VERDICT_LABELS[verdict.verdict]}${overridden ? SHEET_OVERRIDE_SUFFIX : ''}`,
      overridden,
      hint: hints.length > 0 ? hints[0] : null,
    });
  }

  return badges;
}
