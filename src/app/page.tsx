'use client';

import React, { useEffect, useRef, useState } from 'react';
import ImageUploadPanel, { UploadMode, type StatelessBatchPages } from '@/components/ImageUploadPanel';
import type { StackOrder } from '@/lib/recognition/batchMatcher';
import {
  assembleStatelessSession,
  pairStatelessPages,
  StatelessPageCountMismatchError,
  STATELESS_RECOGNIZE_ENABLED,
} from '@/lib/stateless/statelessSession';
import {
  recognizeStudentsStateless,
  StatelessFormTypeMismatchError,
} from '@/lib/stateless/statelessRecognizeClient';
import type { UploadInventory } from '@/lib/uploadInventory';
import RecognitionReview from '@/components/RecognitionReview';
import StudentTable from '@/components/StudentTable';
import ErrorSummary from '@/components/ErrorSummary';
import { RecognitionDraft, type RecognitionValueSource } from '@/lib/recognition/detectCheckmarks';
import { StudentData, ValidationError } from '@/lib/validation/types';
import { isSettledSource, unconfirmedMachineFields } from '@/lib/review/settlement';
import {
  buildReviewSnapshot,
  clearReviewSnapshot,
  describeSnapshot,
  loadReviewSnapshot,
  saveReviewSnapshot,
  stripDraftImages,
  type ReviewSnapshot,
} from '@/lib/session/reviewSnapshot';
import {
  clearDraftImages,
  loadDraftImages,
  mergeDraftImages,
  saveDraftImages,
} from '@/lib/session/imageCache';

/**
 * A rejected request does not necessarily answer in JSON. A body over the
 * platform limit comes back as plain "Request Entity Too Large", and calling
 * res.json() on it surfaced `Unexpected token 'R', "Request En"... is not valid
 * JSON` instead of telling the reviewer what actually happened.
 */
async function readJsonResponse(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }

  const body = (await res.text().catch(() => '')).slice(0, 200);
  if (res.status === 413) {
    throw new Error('전송 용량이 서버 한도를 넘었습니다. 저장된 학생 목록이 과도하게 커졌을 수 있으니 다운로드 후 새 작업으로 이어가주세요.');
  }
  throw new Error(`서버가 JSON이 아닌 응답을 보냈습니다 (HTTP ${res.status}). ${body}`);
}

const hasReviewValue = (value: unknown): boolean => (
  value !== undefined && value !== null && value !== ''
);

/**
 * A saved source is authoritative for a field that has a value. A missing
 * source (or an impossible unresolved/value combination) is the legacy case:
 * keep the value visible, but make the reviewer look at it again.
 */
const sourceForRestoredField = (
  source: RecognitionValueSource | undefined,
  hasSavedValue: boolean,
): RecognitionValueSource | undefined => {
  if (isSettledSource(source) || source === 'auto' || source === 'restored') {
    return source;
  }
  return hasSavedValue ? 'restored' : undefined;
};

function UsageModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="usage-backdrop" role="dialog" aria-modal="true" aria-label="사용법 안내">
      <div className="usage-modal">
        <button type="button" className="usage-close" onClick={onClose} aria-label="사용법 닫기">
          ×
        </button>
        <p className="section-kicker">Usage Manual</p>
        <h2 style={{ fontSize: 26, marginTop: 4, marginBottom: 24 }}>도박예방교육 자동작성기 사용 가이드</h2>
        <div className="usage-steps">
          <div className="usage-step">
            <div className="usage-step-index">01</div>
            <div>
              <h3>업로드 방식 선택</h3>
              <p>개별/순차 촬영은 모바일 카메라 촬영 또는 저장된 사진 업로드를 지원하고, 일괄 스캔은 PDF와 다중 이미지를 지원합니다.</p>
            </div>
          </div>
          <div className="usage-step">
            <div className="usage-step-index">02</div>
            <div>
              <h3>개별 촬영 진행</h3>
              <p>촬영하기 버튼을 누르면 선별검사지 1장, 만족도조사 1장을 순서대로 촬영합니다. 2장 업로드가 끝나면 자동으로 원래 화면으로 돌아옵니다.</p>
            </div>
          </div>
          <div className="usage-step">
            <div className="usage-step-index">03</div>
            <div>
              <h3>검수 후 다운로드</h3>
              <p>인식 결과를 화면에서 확인·수정한 뒤 저장하면 CAGI와 만족도 엑셀 파일을 각각 다운로드할 수 있습니다. 일괄 업로드는 앞면과 뒷면의 장수 및 순서가 같아야 합니다.</p>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 26 }}>
          <button type="button" className="btn-dark" onClick={onClose}>가이드 닫기</button>
        </div>
      </div>
    </div>
  );
}

function UploadModeSelector({ onStart }: { onStart: (mode: UploadMode) => void }) {
  const [selectedMode, setSelectedMode] = useState<UploadMode>('sequential');

  return (
    <section className="section-panel">
      <div className="section-panel-header">
        <h2 className="section-title">응답지 업로드 방식 선택</h2>
      </div>
      <div className="section-panel-body">
        <p style={{ color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 18 }}>
          학생 1명은 선별검사지 1장과 만족도조사 1장으로 구성됩니다. 업로드 방식만 선택하면 바로 작업을 시작합니다.
        </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
        <button
          type="button"
          className={`work-card ${selectedMode === 'sequential' ? 'selected' : ''}`}
          onClick={() => setSelectedMode('sequential')}
        >
          <strong>개별/순차 촬영</strong>
          <span>카메라로 바로 촬영하거나 저장된 사진으로 한 학생의 2장 세트를 업로드합니다.</span>
          <em>모바일 촬영 추천</em>
        </button>
        <button
          type="button"
          className={`work-card ${selectedMode === 'batch' ? 'selected' : ''}`}
          onClick={() => setSelectedMode('batch')}
        >
          <strong>일괄 스캔 업로드</strong>
          <span>앞면 묶음과 뒷면 묶음을 순서대로 올려 여러 학생을 검수합니다.</span>
          <em>PDF / 다중 이미지</em>
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button type="button" className="btn-primary" onClick={() => onStart(selectedMode)}>
          선택한 방식으로 시작
        </button>
      </div>
      </div>
    </section>
  );
}

function BrandHeader() {
  return (
    <div className="brand-header" style={{ justifyContent: 'space-between' }}>
      <div className="brand-lockup" aria-label="한국도박문제예방치유원">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-title">한국도박문제예방치유원</div>
          <div className="brand-subtitle">Korea Problem Gambling Agency</div>
        </div>
      </div>
      {/* QA marker: remove this HTML block after final acceptance.
          MUST bump on every deploy (README.md "작업 프로세스" 참고): format is
          v{배포일 YYYY-MM-DD}.{그날 몇 번째 배포인지, 1부터}. 날짜가 바뀌면 순번은 1로
          리셋. 코드만 바뀌고 이 줄이 그대로면 배포 자체를 빠뜨린 것으로 간주한다. */}
      <span
        aria-label="테스트 버전"
        style={{
          color: 'var(--text-muted)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
        }}
      >
        테스트 버전 v2026-09-07.2
      </span>
    </div>
  );
}

export default function Home() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploadMode, setUploadMode] = useState<UploadMode>('sequential');
  const [students, setStudents] = useState<StudentData[]>([]);
  const [showUsage, setShowUsage] = useState(false);

  const [cagiImageId, setCagiImageId] = useState<string | null>(null);
  const [satImageId, setSatImageId] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<RecognitionDraft[] | null>(null);
  const [currentDraftIndex, setCurrentDraftIndex] = useState<number>(0);

  // Two different failures lose work, so they get two different safety nets.
  // "검수 취소" keeps the page alive, so the discarded drafts -- images included
  // -- are held in memory and can be restored completely. A refresh or a
  // dropped connection wipes memory, so a value-only snapshot goes to
  // localStorage and the images to an expiring IndexedDB cache; see PRD §10-2.
  const discardedDraftsRef = useRef<{ drafts: RecognitionDraft[]; index: number } | null>(null);
  const [canUndoDiscard, setCanUndoDiscard] = useState(false);
  const [restorable, setRestorable] = useState<ReviewSnapshot | null>(null);
  const [restoredFromSnapshot, setRestoredFromSnapshot] = useState(false);

  const [isRecognizing, setIsRecognizing] = useState(false);
  /**
   * Students finished, out of students expected. Only the stateless path can
   * report this -- the batch route answers once, at the end -- so it stays null
   * with the flag off and the recognizing panel renders exactly as before.
   */
  const [recognitionProgress, setRecognitionProgress] = useState<{ completed: number; total: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [shouldScrollToErrors, setShouldScrollToErrors] = useState(false);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [notices, setNotices] = useState<string[]>([]);

  useEffect(() => {
    if (!shouldScrollToErrors || errors.length === 0) return;

    // A failure that names a field is handled inside the review screen, which
    // scrolls to that card and focuses its control. Scrolling to the summary
    // as well would start a second smooth scroll against the first and land
    // wherever the race ended.
    if (errors.some((error) => error.field?.includes('.') && !error.field.startsWith('source.'))) {
      setShouldScrollToErrors(false);
      return;
    }

    errorSummaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setShouldScrollToErrors(false);
  }, [errors, shouldScrollToErrors]);

  // Moving to the next student leaves the page scrolled wherever the previous
  // one's last field was -- usually the bottom -- so the next review opens
  // mid-form and the reviewer has to scroll up before they can start.
  const seenDraftIndex = useRef<number | null>(null);
  useEffect(() => {
    if (seenDraftIndex.current === currentDraftIndex) return;
    const isFirst = seenDraftIndex.current === null;
    seenDraftIndex.current = currentDraftIndex;
    if (isFirst || typeof window === 'undefined') return;
    // Instant, not smooth. Gliding seventeen hundred pixels makes the reviewer
    // wait to start on a form they have not seen yet, and smooth scrolling is
    // driven by requestAnimationFrame, which does not fire while the tab is
    // not compositing -- there the scroll simply never happens.
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [currentDraftIndex]);

  // Restore what was on screen the moment the page last loaded, if anything.
  useEffect(() => {
    const snapshot = loadReviewSnapshot();
    if (snapshot) setRestorable(snapshot);
  }, []);

  // Keep the snapshot current. "검수 취소" deliberately does not clear it --
  // that is exactly the case the user has to be able to come back from.
  useEffect(() => {
    if (!jobId) return;
    saveReviewSnapshot(buildReviewSnapshot({
      jobId,
      uploadMode,
      students,
      drafts,
      currentDraftIndex,
    }));
  }, [jobId, uploadMode, students, drafts, currentDraftIndex]);

  // The images go to IndexedDB instead: a batch is ~30MB, past what
  // localStorage holds. They expire on their own (imageCache TTL) because they
  // are scanned student responses.
  useEffect(() => {
    if (!jobId || !drafts || drafts.length === 0) return;
    void saveDraftImages(jobId, drafts);
  }, [jobId, drafts]);

  const resetDraft = (captureUndo = true) => {
    if (captureUndo && drafts && drafts.length > 0) {
      discardedDraftsRef.current = { drafts, index: currentDraftIndex };
      setCanUndoDiscard(true);
    }
    setCagiImageId(null);
    setSatImageId(null);
    setDrafts(null);
    setCurrentDraftIndex(0);
    setErrors([]);
    setShouldScrollToErrors(false);
    setNotices([]);
  };

  const undoDiscard = () => {
    const discarded = discardedDraftsRef.current;
    if (!discarded) return;
    setDrafts(discarded.drafts);
    setCurrentDraftIndex(discarded.index);
    discardedDraftsRef.current = null;
    setCanUndoDiscard(false);
  };

  const restorePreviousSession = async () => {
    if (!restorable) return;
    const snapshot = restorable;
    // Values come back from localStorage; the originals and the field crops
    // come back from the IndexedDB cache, which drops anything past its TTL.
    const cached = await loadDraftImages(snapshot.jobId);
    const restoredDrafts = snapshot.drafts.map((draft, index) => mergeDraftImages(draft, cached.get(index)));
    const missingImages = restoredDrafts.length > 0 && cached.size === 0;

    setJobId(snapshot.jobId);
    setUploadMode(snapshot.uploadMode as UploadMode);
    setStudents(snapshot.students);
    setDrafts(restoredDrafts.length > 0 ? restoredDrafts : null);
    setCurrentDraftIndex(snapshot.currentDraftIndex);
    setRestoredFromSnapshot(missingImages);
    setRestorable(null);
    setErrors([]);
    setNotices([]);
  };

  const dismissRestorable = () => {
    const jobToClear = restorable?.jobId;
    clearReviewSnapshot(jobToClear);
    void clearDraftImages(jobToClear);
    setRestorable(null);
  };

  const handleStartNewJob = async (selectedMode: UploadMode) => {
    try {
      const res = await fetch('/api/jobs', { method: 'POST' });
      if (!res.ok) throw new Error('서버 응답 오류');
      const data = await res.json();
      // A new class must not inherit the previous one's recovery point.
      clearReviewSnapshot();
      void clearDraftImages();
      discardedDraftsRef.current = null;
      setCanUndoDiscard(false);
      setRestorable(null);
      setRestoredFromSnapshot(false);
      setJobId(data.jobId);
      setUploadMode(selectedMode);
      setStudents([]);
      resetDraft(false);
      setErrors([]);
      setNotices([]);
    } catch (err: any) {
      alert(`새 작업을 시작할 수 없습니다: ${err.message}`);
    }
  };

  /**
   * Flag-on batch recognition: one request per student, no Blob round trip
   * (Task/STATELESS_RECOGNITION_PLAN_2026-09-03.md §3, round B).
   *
   * Everything downstream of this function is the batch path's: the same
   * `studentDrafts` array in the same order reaches `setDrafts`, and the same
   * notices reach `setNotices`. The differences are confined to how the answers
   * are obtained -- two requests at a time, retried per student, and one
   * student's permanent failure leaving an empty draft in its own slot instead
   * of failing all nineteen.
   */
  const runStatelessRecognition = async (
    statelessPages: StatelessBatchPages,
    satisfactionOrder: StackOrder,
    currentJobId: string,
  ) => {
    let pairs;
    try {
      pairs = pairStatelessPages(statelessPages.cagi, statelessPages.satisfaction, satisfactionOrder);
    } catch (error) {
      if (error instanceof StatelessPageCountMismatchError) {
        setErrors([{ code: 'COUNT_MISMATCH', message: error.message }]);
        return;
      }
      throw error;
    }

    let trustUploadedTypes = false;
    while (true) {
      setRecognitionProgress({ completed: 0, total: pairs.length });
      try {
        const outcomes = await recognizeStudentsStateless({
          jobId: currentJobId,
          pairs,
          trustUploadedTypes,
          onProgress: (completed, total) => setRecognitionProgress({ completed, total }),
        });
        const { studentDrafts, warnings } = assembleStatelessSession(outcomes);
        setDrafts(studentDrafts);
        setNotices(warnings);
        setCurrentDraftIndex(0);
        return;
      } catch (error) {
        // The upload-slot guard is about the two stacks, not one student, so it
        // stops the run and asks the same question the batch path asked.
        if (error instanceof StatelessFormTypeMismatchError && !trustUploadedTypes) {
          const shouldUseUploadedTypes = window.confirm(
            '자동 양식 판정과 선택한 업로드 칸이 다릅니다.\n\n사진 보정 결과가 불확실할 수 있습니다. 선택한 업로드 칸을 기준으로 검수 화면으로 계속 진행하시겠습니까?',
          );

          if (shouldUseUploadedTypes) {
            trustUploadedTypes = true;
            continue;
          }

          setErrors([{ code: 'FORM_TYPE_MISMATCH', message: error.message }]);
          return;
        }

        throw error;
      }
    }
  };

  const requestRecognition = async (
    inventory: UploadInventory,
    satisfactionOrder: StackOrder,
    statelessPages?: StatelessBatchPages | null,
  ) => {
    if (!jobId) return;

    setIsRecognizing(true);
    setErrors([]);
    setNotices([]);

    let trustUploadedTypes = false;

    try {
      if (STATELESS_RECOGNIZE_ENABLED && statelessPages) {
        await runStatelessRecognition(statelessPages, satisfactionOrder, jobId);
        return;
      }

      while (true) {
        const res = await fetch('/api/recognize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, inventory, trustUploadedTypes, satisfactionOrder }),
        });
        const data = await res.json();

        if (!res.ok) {
          if (!trustUploadedTypes && data.code === 'FORM_TYPE_MISMATCH' && data.canProceedWithUploadedTypes) {
            const shouldUseUploadedTypes = window.confirm(
              '자동 양식 판정과 선택한 업로드 칸이 다릅니다.\n\n사진 보정 결과가 불확실할 수 있습니다. 선택한 업로드 칸을 기준으로 검수 화면으로 계속 진행하시겠습니까?',
            );

            if (shouldUseUploadedTypes) {
              trustUploadedTypes = true;
              continue;
            }
          }

          setErrors([{ code: data.code || 'RECOGNIZE_ERROR', message: data.error }]);
          return;
        }

        setDrafts(data.studentDrafts);
        setNotices(data.warnings || []);
        setCurrentDraftIndex(0);
        return;
      }
    } catch (err: any) {
      setErrors([{ code: 'API_ERROR', message: `이미지 인식 요청 오류: ${err.message}` }]);
    } finally {
      setIsRecognizing(false);
      setRecognitionProgress(null);
    }
  };

  const handleSequentialUploadSuccess = (type: 'cagi' | 'satisfaction', imageId: string) => {
    if (type === 'cagi') {
      setCagiImageId(imageId);
    } else {
      setSatImageId(imageId);
    }
  };

  const handleTriggerBatchAnalysis = async (
    inventory: UploadInventory,
    satisfactionOrder: StackOrder = 'same',
    statelessPages?: StatelessBatchPages | null,
  ) => {
    if (!jobId) return;

    await requestRecognition(inventory, satisfactionOrder, statelessPages);
  };

  const handleDraftChange = (updatedDraft: RecognitionDraft) => {
    if (!drafts) return;
    const updatedList = [...drafts];
    updatedList[currentDraftIndex] = updatedDraft;
    setDrafts(updatedList);
  };

  const handleSaveStudent = async () => {
    if (!jobId || !drafts) return;

    const currentDraft = drafts[currentDraftIndex];
    const unconfirmedFields = unconfirmedMachineFields(currentDraft);
    if (unconfirmedFields.length > 0) {
      setNotices([`확인되지 않은 자동 입력 ${unconfirmedFields.length}개 — 확인 후 저장할 수 있습니다.`]);
      return;
    }
    const existingRow = savedRowForDraft(currentDraftIndex);
    const outgoing = existingRow >= 0
      ? students.map((student, i) => (i === existingRow ? stripDraftImages(currentDraft) : student))
      : [...students, stripDraftImages(currentDraft)];
    const targetIndex = existingRow >= 0 ? existingRow : outgoing.length - 1;

    setIsSaving(true);
    setErrors([]);
    setShouldScrollToErrors(false);

    try {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          // The saved list is resent whole on every save, so nothing that only
          // the review screen needs may travel with it. The draft's previews
          // and crops are ~1.6MB per student and used to ride along.
          students: outgoing,
          index: targetIndex,
        }),
      });

      const data = await readJsonResponse(res);

      if (!res.ok) {
        if (data.errors) {
          setErrors(data.errors);
        } else {
          setErrors([{ code: 'SAVE_FAILED', message: data.error }]);
        }
        setShouldScrollToErrors(true);
        return;
      }

      setStudents(
        existingRow >= 0
          ? students.map((student, i) => (i === existingRow ? data.student : student))
          : [...students, data.student],
      );
      // Carried past the advance rather than set before it: a correction to an
      // earlier student is the one save whose outcome is not obvious from the
      // screen that follows, and clearing notices on the way out swallowed it.
      const savedNotice = existingRow >= 0
        ? [`${currentDraftIndex + 1}번째 학생을 다시 저장했습니다. 엑셀 ${3 + existingRow}행을 덮어썼습니다.`]
        : [];

      const nextIndex = currentDraftIndex + 1;
      if (nextIndex < drafts.length) {
        setCurrentDraftIndex(nextIndex);
        setErrors([]);
        setNotices(savedNotice);
      } else {
        resetDraft();
      }
    } catch (err: any) {
      setErrors([{ code: 'SAVE_EXCEPTION', message: `학생 저장 처리 중 실패: ${err.message}` }]);
      setShouldScrollToErrors(true);
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Which workbook row this draft already occupies, or -1 if it has none yet.
   *
   * Saved students and drafts are matched on the uploaded image rather than on
   * position: skipping a student breaks the two lists' alignment, and the id
   * survives both a save (which keeps it) and a session restore (which strips
   * only the rendered images). Deriving it means no second list to keep in
   * step and no snapshot version to bump.
   */
  const savedRowForDraft = (index: number): number => {
    const imageId = drafts?.[index]?.source?.cagiImageId;
    if (!imageId) return -1;
    return students.findIndex((student) => student.source?.cagiImageId === imageId);
  };

  /**
   * Compares field by field rather than by serializing the group.
   *
   * JSON.stringify preserves insertion order, and a restored draft has lost
   * whichever fields were undefined when the snapshot was written -- so
   * refilling them appends the keys in a different order and two identical
   * groups stringify differently. That reported "저장되지 않은 수정 있음" on a
   * student whose values matched the saved row exactly.
   */
  const groupDiffers = (a?: Record<string, unknown>, b?: Record<string, unknown>): boolean => {
    const names = Array.from(new Set([...Object.keys(a || {}), ...Object.keys(b || {})]));
    for (const name of names) {
      const left = a?.[name];
      const right = b?.[name];
      const leftEmpty = left === undefined || left === null || left === '';
      const rightEmpty = right === undefined || right === null || right === '';
      if (leftEmpty && rightEmpty) continue;
      if (leftEmpty !== rightEmpty) return true;
      if (String(left) !== String(right)) return true;
    }
    return false;
  };

  const draftDiffersFromSaved = (index: number): boolean => {
    const row = savedRowForDraft(index);
    if (row < 0 || !drafts) return false;
    const draft = drafts[index];
    const saved = students[row];
    return (['basic', 'cagi', 'satisfaction'] as const).some((group) =>
      groupDiffers(
        draft[group] as Record<string, unknown> | undefined,
        saved[group] as Record<string, unknown> | undefined,
      ),
    );
  };

  /**
   * Puts the saved row's values back on screen when the reviewer returns to a
   * student who already has one.
   *
   * The draft carries what the recognizer produced; the row carries the value
   * and its review source. Coming back must restore both: a confirmed/manual
   * field stays settled, while an automatic or legacy value still asks for a
   * person to check it.
   *
   * Fields the reviewer has touched in this session are left alone. Those are
   * deliberate edits not yet saved, and overwriting them is the one way this
   * could destroy work rather than restore it.
   */
  useEffect(() => {
    if (!drafts) return;
    const row = savedRowForDraft(currentDraftIndex);
    if (row < 0) return;

    const draft = drafts[currentDraftIndex];
    const saved = students[row];
    const valueSource = { ...(draft.source?.recognitionValueSource || {}) };
    const editedAt = { ...(draft.source?.recognitionManualEditedAt || {}) };
    const groups: Array<'basic' | 'cagi' | 'satisfaction'> = ['basic', 'cagi', 'satisfaction'];
    const savedValueSources = saved.source?.recognitionValueSource;
    const rebuilt: Record<string, Record<string, unknown>> = {
      basic: { ...((draft.basic || {}) as Record<string, unknown>) },
      cagi: { ...((draft.cagi || {}) as Record<string, unknown>) },
      satisfaction: { ...((draft.satisfaction || {}) as Record<string, unknown>) },
    };
    const fieldKeys = new Set<string>();
    groups.forEach((group) => {
      const savedGroup = (saved[group] || {}) as Record<string, unknown>;
      Object.keys(savedGroup).forEach((name) => fieldKeys.add(`${group}.${name}`));
    });
    Object.keys(savedValueSources || {}).forEach((key) => fieldKeys.add(key));
    let changed = false;

    fieldKeys.forEach((key) => {
      const [group, name] = key.split('.');
      if (!groups.includes(group as typeof groups[number]) || !name) return;

      // Already the reviewer's own answer this session -- theirs wins over the
      // older saved row, including when the saved row carries a different source.
      if (isSettledSource(valueSource[key])) return;

      const savedGroup = (saved[group as typeof groups[number]] || {}) as Record<string, unknown>;
      const draftGroup = rebuilt[group];
      const savedValue = savedGroup[name];
      const hasSavedValue = hasReviewValue(savedValue);
      const nextSource = sourceForRestoredField(savedValueSources?.[key], hasSavedValue);

      if (hasSavedValue && draftGroup[name] !== savedValue) {
        draftGroup[name] = savedValue;
        changed = true;
      }
      // An explicit blank confirmation is persisted without a group value. If
      // recognition produced a value again, the saved blank still wins.
      if (!hasSavedValue && savedValueSources?.[key] === 'blank_ok' && hasReviewValue(draftGroup[name])) {
        delete draftGroup[name];
        changed = true;
      }
      if (nextSource && valueSource[key] !== nextSource) {
        valueSource[key] = nextSource;
        changed = true;
      }
      // The save whitelist carries the source map, not the edit timestamp.
      // Do not let a stale draft timestamp make a restored field look newly
      // hand-edited.
      if (nextSource && editedAt[key] !== undefined) {
        delete editedAt[key];
        changed = true;
      }
    });

    // A second pass finds nothing left to do and this cannot drive itself in a
    // loop: values, sources, and timestamps are all stable after this merge.
    if (!changed) return;
    const updated = {
      ...draft,
      ...rebuilt,
      source: {
        ...(draft.source || {}),
        recognitionValueSource: valueSource,
        recognitionManualEditedAt: editedAt,
      },
    } as RecognitionDraft;
    const list = [...drafts];
    list[currentDraftIndex] = updated;
    setDrafts(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDraftIndex, drafts, students]);

  /**
   * Moves between students without saving.
   *
   * Backwards as well as forwards: a reviewer who notices a mistake two
   * students later could otherwise only get back to it by discarding the batch.
   * Leaving without saving keeps the workbook as it was, which is why the
   * screen has to say when the draft on it no longer matches the saved row.
   */
  const goToDraft = (index: number) => {
    if (!drafts || index < 0 || index >= drafts.length || index === currentDraftIndex) return;
    const leavingUnsaved = draftDiffersFromSaved(currentDraftIndex);
    setCurrentDraftIndex(index);
    setErrors([]);
    setNotices(
      leavingUnsaved
        ? [`${currentDraftIndex + 1}번째 학생의 수정 내용은 저장하지 않았습니다. 엑셀에는 이전 값이 남아 있습니다.`]
        : [],
    );
  };

  const hasDrafts = Boolean(drafts && drafts.length > 0);
  const modeLabel = uploadMode === 'sequential' ? '개별/순차 촬영' : '일괄 스캔 업로드';
  const [isDownloading, setIsDownloading] = useState<'cagi' | 'satisfaction' | null>(null);

  const handleDownload = async (type: 'cagi' | 'satisfaction') => {
    if (!jobId || students.length === 0) {
      alert('저장된 학생 데이터가 없습니다.');
      return;
    }

    setIsDownloading(type);
    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, students }),
      });

      if (!res.ok) {
        const data = await readJsonResponse(res).catch(() => ({}));
        throw new Error(data.error || '다운로드에 실패했습니다.');
      }

      const disposition = res.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `${type}.xlsx`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`다운로드 실패: ${err.message}`);
    } finally {
      setIsDownloading(null);
    }
  };

  return (
    <main className="app-main">
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} />}
      <BrandHeader />
      <header className="product-header">
        <div>
          <p className="eyebrow">한국도박문제예방치유원 예방교육 업무도구</p>
          <h1 className="page-title">응답지 엑셀 자동작성</h1>
          <p className="page-description">
            선별검사지와 만족도조사를 업로드하고, 인식값을 검수한 뒤 중앙 시스템 업로드용 엑셀을 생성합니다.
          </p>
          <div className="hero-actions">
            <a href="#download-files" className="btn-primary">작성 완료 파일 다운로드</a>
            <button type="button" className="btn-secondary" onClick={() => setShowUsage(true)}>자세한 사용법</button>
          </div>
        </div>
        {jobId && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="status-pill">{modeLabel}</span>
            <button className="btn-secondary" onClick={() => setJobId(null)}>
              돌아가기
            </button>
          </div>
        )}
      </header>

      {restorable && (
        <div className="notice" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{ flex: '1 1 320px' }}>
            <strong>이어서 할 수 있는 이전 작업이 있습니다.</strong>
            <div style={{ marginTop: 4, fontSize: 14 }}>
              {describeSnapshot(restorable)} — 원본 이미지는 복원되지 않으며 값과 진단만 복원됩니다.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-primary" onClick={() => { void restorePreviousSession(); }}>
              이어서 하기
            </button>
            <button type="button" className="btn-secondary" onClick={dismissRestorable}>
              삭제하고 새로 시작
            </button>
          </div>
        </div>
      )}

      {!jobId ? (
        <UploadModeSelector onStart={handleStartNewJob} />
      ) : (
        <div className="work-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {canUndoDiscard && (
              <div className="notice" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: '1 1 320px' }}>
                  <strong>검수를 취소했습니다.</strong>
                  <div style={{ marginTop: 4, fontSize: 14 }}>
                    되돌리면 취소 직전 상태로 그대로 복귀합니다.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn-primary" onClick={undoDiscard}>
                    되돌리기
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => { discardedDraftsRef.current = null; setCanUndoDiscard(false); }}>
                    닫기
                  </button>
                </div>
              </div>
            )}
            {restoredFromSnapshot && (
              <div className="notice">
                <strong>이전 작업에서 복원한 값입니다.</strong>
                <div style={{ marginTop: 4, fontSize: 14 }}>
                  원본 이미지는 복원되지 않았습니다. 원본 대조가 필요한 학생은 다시 업로드해주세요.
                </div>
              </div>
            )}
            <ErrorSummary ref={errorSummaryRef} errors={errors} />
            {notices.length > 0 && (
              <div className="notice">
                <strong>확인 안내:</strong>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  {notices.map((notice, index) => (
                    <li key={index}>{notice}</li>
                  ))}
                </ul>
              </div>
            )}

            {!hasDrafts && !isRecognizing && (
              <ImageUploadPanel
                mode={uploadMode}
                jobId={jobId}
                onUploadProgressChange={setIsUploadingFiles}
                onAnalyzeTrigger={handleTriggerBatchAnalysis}
                onUploadSuccess={handleSequentialUploadSuccess}
              />
            )}

            {isUploadingFiles && !isRecognizing && (
              <div className="panel panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                스캔 문서를 분할하고 서버로 전송하고 있습니다.
              </div>
            )}

            {isRecognizing && (
              <div className="panel panel-pad" style={{ textAlign: 'center', minHeight: 220, display: 'grid', placeItems: 'center' }}>
                <div>
                  <div className="spinner" style={{ margin: '0 auto 16px' }} />
                  <h3 style={{ fontSize: 20, marginBottom: 8 }}>응답값을 분석하고 있습니다</h3>
                  <p style={{ color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    업로드된 이미지의 양식 종류와 체크 위치를 확인한 뒤 검수 화면으로 넘깁니다.
                  </p>
                  {recognitionProgress && (
                    <p style={{ color: 'var(--text-muted)', fontWeight: 700, marginTop: 8 }} role="status">
                      학생 {recognitionProgress.completed} / {recognitionProgress.total}명 인식 완료
                    </p>
                  )}
                </div>
              </div>
            )}

            {hasDrafts && drafts && (
              <RecognitionReview
                draft={drafts[currentDraftIndex]}
                jobId={jobId}
                onChange={handleDraftChange}
                onSave={handleSaveStudent}
                saveErrors={errors}
                onReset={resetDraft}
                isSaving={isSaving}
                onNavigate={goToDraft}
                savedRow={savedRowForDraft(currentDraftIndex)}
                hasUnsavedEdits={draftDiffersFromSaved(currentDraftIndex)}
                currentIndex={currentDraftIndex + 1}
                totalCount={drafts.length}
              />
            )}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <StudentTable students={students} />

            <section id="download-files" className="panel panel-pad">
              <p className="section-kicker">Download Files</p>
              <h2 style={{ fontSize: 22, marginBottom: 8 }}>작성 완료 파일 다운로드</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, marginBottom: 18 }}>
                검수 완료된 학생만 두 엑셀 파일의 같은 행 번호에 저장됩니다.
              </p>
              <div className="download-grid">
                <button
                  type="button"
                  className={`download-card ${students.length === 0 ? 'disabled' : ''}`}
                  onClick={() => handleDownload('cagi')}
                  disabled={isDownloading === 'cagi'}
                >
                  <span className="form-label sky">FORM 01</span>
                  <strong>양식_청소년도박문제선별검사_CAGI_3.xlsx</strong>
                  <span>선별검사 데이터(A~M열) 작성본</span>
                  <em>{isDownloading === 'cagi' ? '다운로드 중' : '다운로드'}</em>
                </button>
                <button
                  type="button"
                  className={`download-card ${students.length === 0 ? 'disabled' : ''}`}
                  onClick={() => handleDownload('satisfaction')}
                  disabled={isDownloading === 'satisfaction'}
                >
                  <span className="form-label orange">FORM 02</span>
                  <strong>청소년예방교육만족도.xlsx</strong>
                  <span>예방만족도 설문 데이터(A~N열) 작성본</span>
                  <em>{isDownloading === 'satisfaction' ? '다운로드 중' : '다운로드'}</em>
                </button>
              </div>
            </section>
          </aside>
        </div>
      )}

      <style>{`
        .spinner {
          width: 30px;
          height: 30px;
          border: 3px solid var(--border-subtle);
          border-top-color: var(--brand-primary);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 900px) {
          .work-grid {
            grid-template-columns: 1fr !important;
          }
          .product-header {
            flex-direction: column;
          }
        }
      `}</style>
    </main>
  );
}
