import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { classifyForm, FORM_CLASSIFIER_POLICY_VERSION } from '../../../lib/recognition/classifyForm';
import { recognizeStudentForms } from '../../../lib/recognition/detectCheckmarks';
import {
  createRecognitionOcrDeadlines,
  ROW_ANCHOR_BATCH_BUDGET_MS,
} from '../../../lib/recognition/ocrBudget';
import { matchBatch, isStackOrder } from '../../../lib/recognition/batchMatcher';
import { detectCagiEarlyIntervention } from '../../../lib/recognition/cagiEarlyIntervention';
import { buildSourcePreview } from '../../../lib/recognition/buildSourcePreview';
import {
  evaluateSheetQuality,
  isRegistrationMetaLike,
  type RegistrationMetaLike,
  type SheetQualityVerdict,
} from '../../../lib/recognition/sheetQuality';
import { storeRecognitionMeasurements } from '../../../lib/labelExport/labelStore';
import {
  isSafeJobId,
  isUploadInventory,
  type UploadBatchReference,
  type UploadInventory,
  type UploadKind,
} from '../../../lib/uploadInventory';
import {
  deleteUploadBatches,
  readUploadPage,
  readUploadPageMeta,
  UploadStorageError,
} from '../../../lib/storage/uploadStore';

export function GET() {
  return NextResponse.json({
    service: 'recognize',
    recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
  });
}

export async function POST(req: Request) {
  let requestScratchDir: string | null = null;

  try {
    const { jobId, inventory, trustUploadedTypes = false, satisfactionOrder = 'same' } = await req.json();

    // The back stack comes out of a sheet-feed scanner reversed. Which order
    // it is in is the caller's to state and cannot be inferred: the two forms
    // share no identifying field, so a wrong pairing looks entirely normal.
    // Anything but the two known values is rejected rather than defaulted,
    // because silently falling back to 'same' is exactly the failure this
    // argument exists to prevent.
    if (!isStackOrder(satisfactionOrder)) {
      return NextResponse.json({
        error: '뒷면 묶음 순서 설정이 올바르지 않습니다.',
        code: 'INVALID_STACK_ORDER',
      }, { status: 400 });
    }

    if (!isSafeJobId(jobId) || !isUploadInventory(inventory) || !inventory.cagi || !inventory.satisfaction) {
      return NextResponse.json({ error: '인식에 필요한 업로드 묶음 정보가 올바르지 않습니다.' }, { status: 400 });
    }

    if (inventory.cagi.expectedPageCount !== inventory.satisfaction.expectedPageCount) {
      return NextResponse.json({
        error: `업로드한 묶음의 장수가 일치하지 않습니다. (선별검사지: ${inventory.cagi.expectedPageCount}장, 만족도조사: ${inventory.satisfaction.expectedPageCount}장)`,
        code: 'COUNT_MISMATCH',
        cagiCount: inventory.cagi.expectedPageCount,
        satisfactionCount: inventory.satisfaction.expectedPageCount,
      }, { status: 400 });
    }

    // This directory is request-scoped scratch space only. Uploaded originals always come from Blob.
    requestScratchDir = path.join(os.tmpdir(), 'kpga-scanner', 'recognize', randomUUID());
    await fs.mkdir(requestScratchDir, { recursive: true });

    const cagiFiles = await materializeUploadBatch(requestScratchDir, jobId, 'cagi', inventory.cagi);
    const satisfactionFiles = await materializeUploadBatch(requestScratchDir, jobId, 'satisfaction', inventory.satisfaction);
    const integrityFailure = cagiFiles.failure || satisfactionFiles.failure;
    const uploadOrigins = buildUploadOriginIndex(cagiFiles, satisfactionFiles);

    if (integrityFailure) {
      return NextResponse.json({
        error: '업로드한 페이지를 영속 저장소에서 모두 확인할 수 없습니다. 파일을 다시 업로드해주세요.',
        code: 'UPLOAD_INTEGRITY_ERROR',
        expected: {
          cagi: inventory.cagi.expectedPageCount,
          satisfaction: inventory.satisfaction.expectedPageCount,
        },
        available: {
          cagi: cagiFiles.availablePageNumbers,
          satisfaction: satisfactionFiles.availablePageNumbers,
        },
      }, { status: 409 });
    }

    const cagiPaths: string[] = [];
    const satisfactionPaths: string[] = [];
    const typeMismatches: Array<{
      filename: string;
      uploadedAs: UploadKind;
      detectedAs: UploadKind;
    }> = [];
    const formTypeOverrideWarnings: string[] = [];
    const earlyInterventionFilenames = new Set<string>();
    const earlyInterventionContactFilenames = new Set<string>();
    const allFiles = [...cagiFiles.filePaths, ...satisfactionFiles.filePaths];

    await Promise.all(
      allFiles.map(async (filePath) => {
        const filename = path.basename(filePath);
        const uploadedAs = getUploadedFormType(filename);
        const formType = await classifyForm(filePath);
        const earlyIntervention = uploadedAs === 'cagi'
          ? await detectCagiEarlyIntervention(filePath)
          : { hasMarks: false, hasContactInformation: false };

        if (earlyIntervention.hasMarks) {
          earlyInterventionFilenames.add(filename);
        }
        if (earlyIntervention.hasContactInformation) {
          earlyInterventionContactFilenames.add(filename);
        }

        const shouldKeepAsCagiWithNotice = uploadedAs === 'cagi'
          && formType === 'satisfaction'
          && (earlyIntervention.hasMarks || earlyIntervention.hasContactInformation);
        const hasFormTypeMismatch = Boolean(
          uploadedAs
          && formType !== 'unknown'
          && uploadedAs !== formType
          && !shouldKeepAsCagiWithNotice,
        );

        if (hasFormTypeMismatch && !trustUploadedTypes) {
          typeMismatches.push({ filename, uploadedAs: uploadedAs!, detectedAs: formType as UploadKind });
          return;
        }

        if (hasFormTypeMismatch && trustUploadedTypes) {
          formTypeOverrideWarnings.push(buildUploadedTypeOverrideWarning(filename, uploadedAs!, formType as UploadKind));
        }

        const effectiveFormType = shouldKeepAsCagiWithNotice
          ? 'cagi'
          : hasFormTypeMismatch && trustUploadedTypes
            ? uploadedAs!
            : formType === 'unknown' && uploadedAs
              ? uploadedAs
              : formType;

        if (effectiveFormType === 'cagi') {
          cagiPaths.push(filePath);
        } else if (effectiveFormType === 'satisfaction') {
          satisfactionPaths.push(filePath);
        }
      }),
    );

    const earlyInterventionWarnings = [
      ...buildEarlyInterventionWarnings(cagiPaths, earlyInterventionFilenames),
      ...buildEarlyInterventionContactWarnings(cagiPaths, earlyInterventionContactFilenames),
    ];

    if (typeMismatches.length > 0) {
      return NextResponse.json({
        error: buildFormTypeMismatchMessage(typeMismatches),
        code: 'FORM_TYPE_MISMATCH',
        recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
        mismatches: typeMismatches,
        canProceedWithUploadedTypes: true,
      }, { status: 400 });
    }

    if (cagiPaths.length !== satisfactionPaths.length) {
      return NextResponse.json({
        error: `업로드된 양식별 인식 장수가 일치하지 않습니다. (선별검사지: ${cagiPaths.length}장, 만족도조사: ${satisfactionPaths.length}장)`,
        code: 'COUNT_MISMATCH',
        cagiCount: cagiPaths.length,
        satisfactionCount: satisfactionPaths.length,
        warnings: [...earlyInterventionWarnings, ...formTypeOverrideWarnings],
        recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
      }, { status: 400 });
    }

    if (cagiPaths.length === 0) {
      return NextResponse.json({
        error: '인식할 유효한 양식 파일이 없습니다. 올바른 칸에 다시 업로드해주세요.',
        code: 'EMPTY_FORMS',
      }, { status: 400 });
    }

    let matchedPairs;
    try {
      matchedPairs = matchBatch(cagiPaths, satisfactionPaths, satisfactionOrder);
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 매칭 오류';
      return NextResponse.json({ error: `파일 정렬 및 매칭 중 오류가 발생했습니다: ${message}`, code: 'MATCH_ERROR' }, { status: 400 });
    }

    const studentDrafts = [];
    // Row anchor OCR remains batch-bounded. Age digits use a separate
    // per-student deadline so later students are still allowed one OCR attempt.
    const rowOcrDeadlineAt = Date.now() + ROW_ANCHOR_BATCH_BUDGET_MS;
    for (let studentIndex = 0; studentIndex < matchedPairs.length; studentIndex++) {
      const pair = matchedPairs[studentIndex];
      // Read the stored F1 meta before recognizing: its presence is the
      // photo-provenance flag that arms photo-only refusals (the band check
      // cost the scan set 4 correct cells when it ran unconditionally), and
      // the same values feed the sheet-quality attachment below so meta is
      // read once per sheet.
      const [cagiRegistration, satisfactionRegistration] = await Promise.all([
        readRegistrationForPath(jobId, pair.cagiPath, uploadOrigins),
        readRegistrationForPath(jobId, pair.satisfactionPath, uploadOrigins),
      ]);
      const draft = await recognizeStudentForms(
        pair.cagiPath,
        pair.satisfactionPath,
        {
          ...createRecognitionOcrDeadlines(rowOcrDeadlineAt, studentIndex),
          cagiPhotoProvenance: Boolean(cagiRegistration),
          satisfactionPhotoProvenance: Boolean(satisfactionRegistration),
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
        recognitionDecisionTrace,
        recognitionMeasurements,
        ...recognizedDraft
      } = draft;
      const cagiImageId = path.basename(pair.cagiPath).split('.')[0];
      await storeRecognitionMeasurements({
        jobId,
        studentIndex,
        cagiImageId,
        measurements: recognitionMeasurements || {},
      });
      const preview = await buildSourcePreview(
        pair.cagiPath,
        pair.satisfactionPath,
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
        pair.cagiPath,
        pair.satisfactionPath,
        cagiRegistration,
        satisfactionRegistration,
      );

      studentDrafts.push({
        ...recognizedDraft,
        ...(sheetQuality ? { sheetQuality } : {}),
        source: {
          cagiImageId,
          satisfactionImageId: path.basename(pair.satisfactionPath).split('.')[0],
          cagiImageDataUrl: preview.cagiImageDataUrl,
          satisfactionImageDataUrl: preview.satisfactionImageDataUrl,
          cropDataUrls: preview.cropDataUrls,
          cropDebugDataUrls: preview.cropDebugDataUrls,
          recognitionCropSource: preview.recognitionCropSource,
          recognitionCropDiagnostic: preview.recognitionCropDiagnostic,
          recognitionRegistration,
          recognitionValueSource,
          recognitionDecisionTrace,
        },
      });
    }

    // No originals are needed after the review payload is built. Failed cleanup must not hide a valid result.
    try {
      await deleteUploadBatches(jobId, [
        { type: 'cagi', batch: inventory.cagi },
        { type: 'satisfaction', batch: inventory.satisfaction },
      ]);
    } catch (error) {
      console.error('Unable to remove recognized upload batches', error);
    }

    return NextResponse.json({
      studentDrafts,
      warnings: [...earlyInterventionWarnings, ...formTypeOverrideWarnings],
      recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
    });
  } catch (error) {
    if (error instanceof UploadStorageError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
    }

    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    return NextResponse.json({ error: `이미지 인식 결과 처리 중 실패: ${message}` }, { status: 500 });
  } finally {
    if (requestScratchDir) {
      await fs.rm(requestScratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

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

async function materializeUploadBatch(
  scratchDir: string,
  jobId: string,
  type: UploadKind,
  batch: UploadBatchReference,
) {
  const result = await Promise.all(
    Array.from({ length: batch.expectedPageCount }, async (_, index) => {
      const pageNumber = index + 1;
      const page = await readUploadPage(jobId, type, batch, pageNumber);
      if (!page) {
        return { pageNumber, filePath: null };
      }

      const filePath = path.join(scratchDir, `${type}_page_${String(pageNumber).padStart(4, '0')}.jpg`);
      await fs.writeFile(filePath, page.data);
      return { pageNumber, filePath };
    }),
  );

  return {
    filePaths: result.flatMap((page) => page.filePath ? [page.filePath] : []),
    availablePageNumbers: result.flatMap((page) => page.filePath ? [page.pageNumber] : []),
    failure: result.some((page) => !page.filePath),
    // Where each scratch file came from. Written here — the only place that
    // knows — so nothing downstream has to re-derive a page number from a
    // filename or from a student's position in the matched list.
    origins: result.flatMap((page) => page.filePath
      ? [{ filePath: page.filePath, type, batch, pageNumber: page.pageNumber }]
      : []),
  };
}

/**
 * Scratch file path -> the stored upload page it was written from.
 *
 * Keyed by PATH, not by student index, and that is the whole point. The
 * satisfaction stack can be paired in reverse (`satisfactionOrder:
 * 'reversed'`), in which case `matchBatch` hands student 0 the LAST
 * satisfaction file; classification can also move a file between the two
 * lists. Both operate on paths and never rewrite them, so looking the path up
 * here always returns the physical page whose bytes the quality evaluator is
 * about to measure.
 */
type UploadPageOrigin = {
  type: UploadKind;
  batch: UploadBatchReference;
  pageNumber: number;
};

function buildUploadOriginIndex(
  ...batches: Array<{ origins: Array<{ filePath: string } & UploadPageOrigin> }>
): Map<string, UploadPageOrigin> {
  const index = new Map<string, UploadPageOrigin>();
  for (const materialized of batches) {
    for (const origin of materialized.origins) {
      index.set(origin.filePath, {
        type: origin.type,
        batch: origin.batch,
        pageNumber: origin.pageNumber,
      });
    }
  }
  return index;
}

/**
 * Capture metadata for one materialized sheet, or null when it carries none.
 *
 * Never throws: a missing, malformed or unreadable sidecar reads as null, and
 * the evaluator treats null as provenance-unknown ('good' /
 * `no-registration-meta`) — the reading the scan path depends on.
 */
async function readRegistrationForPath(
  jobId: string,
  filePath: string,
  origins: Map<string, UploadPageOrigin>,
): Promise<RegistrationMetaLike | null> {
  const origin = origins.get(filePath);
  if (!origin) {
    return null;
  }

  try {
    const stored = await readUploadPageMeta(jobId, origin.type, origin.batch, origin.pageNumber);
    return isRegistrationMetaLike(stored) ? stored : null;
  } catch (error) {
    console.error('Unable to read registration meta for recognized page', filePath, error);
    return null;
  }
}

function getUploadedFormType(filename: string): UploadKind | undefined {
  const lowerName = filename.toLowerCase();
  if (lowerName.startsWith('cagi_')) return 'cagi';
  if (lowerName.startsWith('satisfaction_')) return 'satisfaction';
  return undefined;
}

function buildEarlyInterventionWarnings(cagiPaths: string[], markedFilenames: Set<string>): string[] {
  const pageNumbers = getCagiPageNumbers(cagiPaths, markedFilenames);
  if (pageNumbers.length === 0) return [];
  return [`선별검사지 ${pageNumbers.join(', ')}페이지에서 조기개입 서비스 표기 흔적이 감지되었습니다. 해당 영역은 응답 추출 대상에서 제외하고 선별검사지 문항만 인식합니다.`];
}

function buildEarlyInterventionContactWarnings(cagiPaths: string[], contactFilenames: Set<string>): string[] {
  const pageNumbers = getCagiPageNumbers(cagiPaths, contactFilenames);
  if (pageNumbers.length === 0) return [];
  return [`선별검사지 ${pageNumbers.join(', ')}페이지의 조기개입 서비스 영역에서 이름 또는 연락처 입력 흔적이 감지되었습니다. 개인정보는 저장하지 않으며 원본을 확인한 뒤 검수를 진행해주세요.`];
}

function getCagiPageNumbers(cagiPaths: string[], filenames: Set<string>): number[] {
  return [...cagiPaths]
    .map((filePath) => path.basename(filePath))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((filename, index) => filenames.has(filename) ? index + 1 : undefined)
    .filter((pageNumber): pageNumber is number => pageNumber !== undefined);
}

function buildFormTypeMismatchMessage(
  mismatches: Array<{ filename: string; uploadedAs: UploadKind; detectedAs: UploadKind }>,
): string {
  const first = mismatches[0];
  const uploadedLabel = first.uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = first.detectedAs === 'cagi' ? '선별검사지' : '만족도조사';
  if (mismatches.length === 1) {
    return `${first.filename} 파일은 ${uploadedLabel} 칸에 업로드되었지만, 이미지 내용은 ${detectedLabel} 양식으로 보입니다. 올바른 칸에 다시 업로드해주세요.`;
  }
  return `업로드 칸과 이미지 내용이 다른 파일이 ${mismatches.length}개 있습니다. 첫 번째 문제 파일: ${first.filename} (${uploadedLabel} 칸, 실제 ${detectedLabel} 양식).`;
}

function buildUploadedTypeOverrideWarning(filename: string, uploadedAs: UploadKind, detectedAs: UploadKind): string {
  const uploadedLabel = uploadedAs === 'cagi' ? '선별검사지' : '만족도조사';
  const detectedLabel = detectedAs === 'cagi' ? '선별검사지' : '만족도조사';
  return `${filename}: 자동 인식 추정(${detectedLabel}) 대신 선택한 업로드 칸(${uploadedLabel})을 적용했습니다. 검수 화면에서 원본과 인식 결과를 확인해주세요.`;
}
