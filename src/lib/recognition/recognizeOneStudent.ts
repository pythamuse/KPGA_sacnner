import { recognizeStudentForms } from './detectCheckmarks';
import { buildSourcePreview } from './buildSourcePreview';
import {
  evaluateSheetQuality,
  type RegistrationMetaLike,
  type SheetQualityVerdict,
} from './sheetQuality';
import type { RecognitionOcrDeadlines } from './ocrBudget';

/**
 * One student's two sheets -> the review draft the client receives.
 *
 * Lifted verbatim out of the batch route's per-student loop
 * (`src/app/api/recognize/route.ts`) so the stateless per-student route
 * (`/api/recognize/student`) produces the same object without duplicating the
 * assembly. Nothing here knows where the two files came from: the batch route
 * materializes them out of Blob, the stateless route writes them from the
 * request body, and both hand over plain paths.
 *
 * `recognitionMeasurements` is returned rather than stored. It is a
 * server-only outlet (never part of the response), and the caller owns the
 * job/sidecar identity it has to be filed under.
 */
export interface RecognizeOneStudentInput {
  cagiPath: string;
  satisfactionPath: string;
  /** Stored F1 capture meta, or null. Its presence is the photo-provenance flag. */
  cagiRegistration: RegistrationMetaLike | null;
  satisfactionRegistration: RegistrationMetaLike | null;
  ocrDeadlines: RecognitionOcrDeadlines;
  /** Stable per-sheet identifiers carried into `source` (batch: the scratch file stem). */
  cagiImageId: string;
  satisfactionImageId: string;
}

export async function recognizeOneStudent(input: RecognizeOneStudentInput) {
  const draft = await recognizeStudentForms(
    input.cagiPath,
    input.satisfactionPath,
    {
      ...input.ocrDeadlines,
      cagiPhotoProvenance: Boolean(input.cagiRegistration),
      satisfactionPhotoProvenance: Boolean(input.satisfactionRegistration),
    },
  );
  const {
    recognitionCropRects,
    recognitionCandidateRects,
    recognitionCropSource,
    recognitionCropDiagnostic,
    recognitionRegistration,
    recognitionRejectedCandidateRects,
    recognitionValueSource,
    recognitionContested,
    recognitionSuggestion,
    recognitionDecisionTrace,
    recognitionEvidence,
    recognitionMeasurements,
    ...recognizedDraft
  } = draft;
  const preview = await buildSourcePreview(
    input.cagiPath,
    input.satisfactionPath,
    recognitionCropRects,
    recognitionCropSource,
    recognitionCropDiagnostic,
    recognitionCandidateRects,
    recognitionRejectedCandidateRects,
  );

  // Same evaluator as POST /api/uploads/quality (spec F3.2 consistency
  // requirement) — two different judges would let "it said fine at upload"
  // disagree with the review screen. Whatever F1 meta the client stored
  // with these two pages is read back by path, so a photographed sheet can
  // reach the review screen as retake/unusable/overridden; the scan path
  // carries no meta and stays provenance-unknown ('good' with reason
  // no-registration-meta).
  const sheetQuality = await buildSheetQualityAttachment(
    input.cagiPath,
    input.satisfactionPath,
    input.cagiRegistration,
    input.satisfactionRegistration,
  );

  const student = {
    ...recognizedDraft,
    ...(sheetQuality ? { sheetQuality } : {}),
    source: {
      cagiImageId: input.cagiImageId,
      satisfactionImageId: input.satisfactionImageId,
      cagiImageDataUrl: preview.cagiImageDataUrl,
      satisfactionImageDataUrl: preview.satisfactionImageDataUrl,
      cropDataUrls: preview.cropDataUrls,
      cropDebugDataUrls: preview.cropDebugDataUrls,
      recognitionCropSource: preview.recognitionCropSource,
      recognitionCropDiagnostic: preview.recognitionCropDiagnostic,
      recognitionRegistration,
      recognitionValueSource,
      recognitionContested,
      recognitionSuggestion,
      recognitionDecisionTrace,
      recognitionEvidence,
    },
  };

  return { student, measurements: recognitionMeasurements || {} };
}

/** The assembled draft, inferred from the literal above so it cannot drift from it. */
export type RecognizeOneStudentResult = Awaited<ReturnType<typeof recognizeOneStudent>>;
export type RecognizedStudentDraft = RecognizeOneStudentResult['student'];

/**
 * Attaches per-sheet quality verdicts to a student draft without ever being
 * able to fail recognition: a sheet whose evaluation throws simply has no
 * verdict attached (spec F3.3 — the verdict is a reviewer signal, never a
 * gate). Draft-field safety: `validateStudent` checks only known fields and
 * `/api/students` rebuilds the saved student from an explicit whitelist, so
 * this extra top-level field travels to the review client and is dropped at
 * save, like the other review-only draft fields.
 */
async function buildSheetQualityAttachment(
  cagiPath: string,
  satisfactionPath: string,
  cagiRegistration: RegistrationMetaLike | null,
  satisfactionRegistration: RegistrationMetaLike | null,
): Promise<{ cagi?: SheetQualityVerdict; satisfaction?: SheetQualityVerdict } | null> {
  const attachment: { cagi?: SheetQualityVerdict; satisfaction?: SheetQualityVerdict } = {};

  try {
    attachment.cagi = await evaluateSheetQuality({
      imagePath: cagiPath,
      formType: 'cagi',
      registration: cagiRegistration,
    });
  } catch (error) {
    console.error('cagi sheet-quality evaluation failed', error);
  }

  try {
    attachment.satisfaction = await evaluateSheetQuality({
      imagePath: satisfactionPath,
      formType: 'satisfaction',
      registration: satisfactionRegistration,
    });
  } catch (error) {
    console.error('satisfaction sheet-quality evaluation failed', error);
  }

  return attachment.cagi || attachment.satisfaction ? attachment : null;
}
