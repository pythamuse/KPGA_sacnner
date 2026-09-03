import type { UploadKind } from '../uploadInventory';

/**
 * The batch route's upload-slot guard and its notices, expressed one sheet at
 * a time (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §3, round B).
 *
 * `/api/recognize` decides these while every page of the batch is still in one
 * request: it classifies each file, refuses a bundle whose contents disagree
 * with the slot it was uploaded to, and reports early-intervention traces as
 * one warning listing the affected CAGI page numbers. The stateless route sees
 * exactly one student per request, so the same rules have to be expressible
 * for a single pair of sheets — that is all this module is. The strings are
 * the batch route's, verbatim, so the reviewer reads the same sentence
 * whichever path produced it.
 *
 * Deliberately NOT shared with `src/app/api/recognize/route.ts`: the flag-off
 * batch path must stay byte-identical, so the batch route keeps its own copies
 * and `tests/stateless-form-notices.test.ts` pins the two against each other by
 * running both routes over the same image.
 */

export type ClassifiedFormLike = UploadKind | 'unknown';

export interface FormTypeMismatch {
  filename: string;
  uploadedAs: UploadKind;
  detectedAs: UploadKind;
}

export interface SheetTypeDecision {
  /** The slot/content disagreement the guard refuses, unless the caller trusts the slot. */
  mismatch: FormTypeMismatch | null;
  /** Set when the caller trusted the slot despite a disagreement. */
  overrideWarning: string | null;
}

/**
 * One sheet's verdict under the batch rules.
 *
 * `keepAsCagiWithNotice` is the batch route's `shouldKeepAsCagiWithNotice`: a
 * CAGI sheet whose early-intervention block is filled in scores as a
 * satisfaction form often enough that refusing it would reject valid paper, so
 * it stays CAGI. Only the CAGI slot can set it, exactly as in the batch route.
 */
export function decideSheetType(input: {
  filename: string;
  uploadedAs: UploadKind;
  detectedAs: ClassifiedFormLike;
  keepAsCagiWithNotice: boolean;
  trustUploadedTypes: boolean;
}): SheetTypeDecision {
  const hasMismatch = input.detectedAs !== 'unknown'
    && input.uploadedAs !== input.detectedAs
    && !input.keepAsCagiWithNotice;

  if (!hasMismatch) {
    return { mismatch: null, overrideWarning: null };
  }

  if (input.trustUploadedTypes) {
    return {
      mismatch: null,
      overrideWarning: buildUploadedTypeOverrideWarning(
        input.filename,
        input.uploadedAs,
        input.detectedAs as UploadKind,
      ),
    };
  }

  return {
    mismatch: {
      filename: input.filename,
      uploadedAs: input.uploadedAs,
      detectedAs: input.detectedAs as UploadKind,
    },
    overrideWarning: null,
  };
}

export function buildEarlyInterventionWarnings(pageNumbers: number[]): string[] {
  if (pageNumbers.length === 0) return [];
  return [`선별검사지 ${pageNumbers.join(', ')}페이지에서 조기개입 서비스 표기 흔적이 감지되었습니다. 해당 영역은 응답 추출 대상에서 제외하고 선별검사지 문항만 인식합니다.`];
}

export function buildEarlyInterventionContactWarnings(pageNumbers: number[]): string[] {
  if (pageNumbers.length === 0) return [];
  return [`선별검사지 ${pageNumbers.join(', ')}페이지의 조기개입 서비스 영역에서 이름 또는 연락처 입력 흔적이 감지되었습니다. 개인정보는 저장하지 않으며 원본을 확인한 뒤 검수를 진행해주세요.`];
}

export function buildFormTypeMismatchMessage(mismatches: FormTypeMismatch[]): string {
  const first = mismatches[0];
  const uploadedLabel = first.uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = first.detectedAs === 'cagi' ? '선별검사지' : '만족도조사';
  if (mismatches.length === 1) {
    return `${first.filename} 파일은 ${uploadedLabel} 칸에 업로드되었지만, 이미지 내용은 ${detectedLabel} 양식으로 보입니다. 올바른 칸에 다시 업로드해주세요.`;
  }
  return `업로드 칸과 이미지 내용이 다른 파일이 ${mismatches.length}개 있습니다. 첫 번째 문제 파일: ${first.filename} (${uploadedLabel} 칸, 실제 ${detectedLabel} 양식).`;
}

export function buildUploadedTypeOverrideWarning(
  filename: string,
  uploadedAs: UploadKind,
  detectedAs: UploadKind,
): string {
  const uploadedLabel = uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = detectedAs === 'cagi' ? '선별검사지' : '만족도조사';
  return `${filename}: 자동 인식 추정(${detectedLabel}) 대신 선택한 업로드 칸(${uploadedLabel})을 적용했습니다. 검수 화면에서 원본과 인식 결과를 확인해주세요.`;
}
