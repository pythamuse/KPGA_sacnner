import React from 'react';
import { RecognitionDraft, type RecognitionValueSource } from '../lib/recognition/detectCheckmarks';
import {
  buildSheetQualityBadges,
  type SheetQualityLevel,
} from '../lib/recognition/sheetQualityDisplay';
import { ValidationError } from '../lib/validation/types';
import {
  contestedUnconfirmedFields,
  isSettledSource,
  unconfirmedMachineFields,
} from '../lib/review/settlement';
import { describeEvidence, remarkCause } from '../lib/review/evidence';

interface RecognitionReviewProps {
  draft: RecognitionDraft;
  jobId: string;
  onChange: (updatedDraft: RecognitionDraft) => void;
  onSave: () => void;
  onReset: () => void;
  isSaving: boolean;
  onNavigate?: (index: number) => void;
  /** Workbook row this student already occupies, or -1 if never saved. */
  savedRow?: number;
  hasUnsavedEdits?: boolean;
  saveErrors?: ValidationError[];
  currentIndex?: number;
  totalCount?: number;
}

const confidenceLabel = {
  high: '높음',
  medium: '확인',
  low: '낮음',
};

const confidenceRank = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Same three-step palette the confidence badges use, so a capture verdict and
 * a field confidence read on the same scale (spec F3 — reviewer signal only).
 */
const sheetQualityBadgeStyle: Record<SheetQualityLevel, { border: string; text: string; bg: string }> = {
  good: { border: '#bfe3d2', text: 'var(--success)', bg: 'var(--success-bg)' },
  'retake-suggested': { border: '#f5d29a', text: 'var(--warning)', bg: 'var(--warning-bg)' },
  unusable: { border: '#f0b7b2', text: 'var(--error)', bg: 'var(--error-bg)' },
};

const cropSourceLabel = {
  grid: '격자 검증 완료',
  'grid-candidate': '격자 후보',
  row: '행 검출',
  'row-fallback': '격자 후보 -> 행 폴백',
  fixed: '위치 특정 실패 (구역 전체 표시)',
};

export function describeCropSource(
  draft: RecognitionDraft,
  key: string,
): { sourceLabel?: string; registrationLabel?: string; registrationStatus?: string } | null {
  const source = draft.source?.recognitionCropSource?.[key];
  if (!source) return null;

  const registration = draft.source?.recognitionRegistration?.[key];
  const registrationLabel = registration?.status === 'verified'
    ? '좌표 검증'
    : registration?.status === 'candidate'
      ? '좌표 후보'
      : registration?.status === 'failed'
        ? '좌표 실패'
        : undefined;

  return {
    sourceLabel: cropSourceLabel[source],
    ...(registrationLabel ? { registrationLabel } : {}),
    ...(registration?.status ? { registrationStatus: registration.status } : {}),
  };
}

/**
 * How each field's options read, so a suggestion can name the option the way
 * the reviewer sees it in the `select` rather than as a bare number.
 *
 * Written out here rather than by refactoring the `select` markup to share a
 * table: those controls carry the values this whole screen exists to protect,
 * and this is read only by the suggestion strip. `review-snapshot.test.ts`
 * checks every label here against the option the select actually renders, so
 * drift fails a test rather than mislabelling a guess.
 */
export const suggestionOptionLabels = (key: string): Record<string, string> | undefined => {
  if (key === 'basic.gender') return { 남: '남', 여: '여' };
  if (key === 'basic.schoolType') {
    return {
      초등학교: '초등학교', 중학교: '중학교', 고등학교: '고등학교', 학교외기관: '학교외기관',
    };
  }
  if (key === 'basic.grade') {
    return {
      '1학년': '1학년', '2학년': '2학년', '3학년': '3학년',
      '4학년': '4학년', '5학년': '5학년', '6학년': '6학년', 해당없음: '해당없음',
    };
  }
  if (key.startsWith('cagi.')) {
    return { 0: '0 없다', 1: '1 가끔 있다', 2: '2 자주 있다', 3: '3 거의 항상 있다' };
  }
  if (key === 'satisfaction.q01') {
    return { 1: '1 없음', 2: '2 1회', 3: '3 2회', 4: '4 3회 이상' };
  }
  if (['satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06'].includes(key)) {
    return { 0: '0 아니오', 1: '1 예' };
  }
  if (['satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10'].includes(key)) {
    return {
      0: '0 매우 그렇지 않다', 1: '1 그렇지 않다', 2: '2 보통이다', 3: '3 그렇다', 4: '4 매우 그렇다',
    };
  }
  return undefined;
};

export default function RecognitionReview({
  draft,
  jobId,
  onChange,
  onSave,
  onReset,
  isSaving,
  onNavigate,
  savedRow = -1,
  hasUnsavedEdits = false,
  saveErrors = [],
  currentIndex = 1,
  totalCount = 1,
}: RecognitionReviewProps) {
  const [showRoiBoxes, setShowRoiBoxes] = React.useState(false);
  // The per-field decision traces are engineering output -- gate names, sample
  // counts, alignment offsets. They were invaluable for finding out why a cell
  // was refused and they are noise to someone checking nineteen students, and
  // the wall of numbers is what a reviewer has to read past to find the four
  // fields that actually need them. Off by default, one click away.
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);
  const unconfirmedMachineFieldKeys = unconfirmedMachineFields(draft);
  const unconfirmedMachineFieldSet = new Set(unconfirmedMachineFieldKeys);
  const contestedUnconfirmedFieldKeys = contestedUnconfirmedFields(draft);
  const contestedUnconfirmedFieldSet = new Set(contestedUnconfirmedFieldKeys);

  const buildReviewSource = (field: string, valueSource: RecognitionValueSource) => {
    const priorTrace = draft.source?.recognitionDecisionTrace?.[field];
    const reviewMessage = valueSource === 'confirmed'
      ? 'The reviewer confirmed the recognized value.'
      : valueSource === 'blank_ok'
        ? 'The reviewer confirmed that the candidate field is blank.'
        : valueSource === 'manual'
          ? 'Value was entered or changed during manual review.'
          : 'The reviewer confirmed the current value.';

    return {
      ...(draft.source || {}),
      recognitionValueSource: {
        ...(draft.source?.recognitionValueSource || {}),
        [field]: valueSource,
      },
      recognitionManualEditedAt: {
        ...(draft.source?.recognitionManualEditedAt || {}),
        [field]: new Date().toISOString(),
      },
      recognitionDecisionTrace: {
        ...(draft.source?.recognitionDecisionTrace || {}),
        [field]: priorTrace
          ? `${priorTrace} ${reviewMessage}`
          : reviewMessage,
      },
    };
  };

  const buildManualReviewSource = (field: string) => buildReviewSource(field, 'manual');

  const handleBasicChange = (field: string, val: any) => {
    onChange({
      ...draft,
      source: buildManualReviewSource(`basic.${field}`),
      basic: {
        ...draft.basic,
        [field]: val,
      },
    });
  };

  const handleCagiChange = (field: string, val: number) => {
    onChange({
      ...draft,
      source: buildManualReviewSource(`cagi.${field}`),
      cagi: {
        ...draft.cagi,
        [field]: val,
      },
    });
  };

  const handleSatisfactionChange = (field: string, val: number) => {
    onChange({
      ...draft,
      source: buildManualReviewSource(`satisfaction.${field}`),
      satisfaction: {
        ...draft.satisfaction,
        [field]: val,
      },
    });
  };

  /**
   * Whether the reviewer has already dealt with this field.
   *
   * Confidence is what the recognizer thought before anyone looked; it never
   * changes afterwards. Without this, a field the reviewer has just fixed goes
   * on being highlighted and go on being counted, so "확인 필요 4개" stays at
   * four however much work gets done and the reviewer has to hold the
   * remainder in their head across nineteen students.
   */
  const isSettled = (key: string) => {
    return isSettledSource(draft.source?.recognitionValueSource?.[key]);
  };

  const fieldDomId = (key: string) => `review-field-${key.replace(/\./g, '-')}`;

  const focusField = (key: string) => {
    if (typeof document === 'undefined') return;
    const card = document.getElementById(fieldDomId(key));
    if (!card) return;
    // Instant. A smooth scroll runs on requestAnimationFrame, and when that
    // does not fire the focus below still lands -- leaving the reviewer typing
    // into a field that is nowhere on screen. Arriving is the point; gliding
    // there is not worth that failure mode.
    card.scrollIntoView({ behavior: 'auto', block: 'center' });
    // Focus the control rather than the card, so the reviewer can answer with
    // the keyboard the moment they arrive.
    const control = card.querySelector<HTMLElement>('select, input');
    control?.focus({ preventScroll: true });
  };

  /**
   * Takes the reviewer to the field that blocked the save.
   *
   * The save reports "필수 항목 N개가 비어 있어" at the very bottom of the
   * page and then leaves them to find those fields among twenty-three cards --
   * the same hunt the attention list exists to remove, at the one moment the
   * reviewer already believes they are finished. `source.*` errors name an
   * upload, not a card, so they are left to the summary.
   */
  React.useEffect(() => {
    const blocking = saveErrors.find(
      (error) => error.field && error.field.includes('.') && !error.field.startsWith('source.'),
    );
    if (!blocking?.field) return;
    focusField(blocking.field);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveErrors]);

  const currentValue = (key: string): unknown => {
    const [group, name] = key.split('.');
    if (group === 'basic') return (draft.basic as Record<string, unknown>)[name];
    if (group === 'cagi') return (draft.cagi as Record<string, unknown>)[name];
    return (draft.satisfaction as Record<string, unknown>)[name];
  };

  /**
   * Accepts the recognized value as it stands.
   *
   * A low-confidence field is often already right -- the recognizer was unsure,
   * the reviewer looks at the crop and agrees. Re-picking the same option in a
   * `select` fires no change event, so without this there is no way to say
   * "yes, that one" and the field can never leave the outstanding list.
   */
  const confirmField = (key: string) => {
    const [group, name] = key.split('.');
    const value = currentValue(key);
    const valueSource: RecognitionValueSource = needsValue(key) ? 'blank_ok' : 'confirmed';
    // Including when there is no value: a student who answered nothing is a
    // fact about the form, and the reviewer needs a way to record having seen
    // it. Keep this explicit confirmation separate from a value that was
    // changed by hand: both are useful labels, but they mean different things.
    const source = buildReviewSource(key, valueSource);
    if (group === 'basic') {
      onChange({ ...draft, source, basic: { ...draft.basic, [name]: value } });
    } else if (group === 'cagi') {
      onChange({ ...draft, source, cagi: { ...draft.cagi, [name]: value as number } });
    } else {
      onChange({ ...draft, source, satisfaction: { ...draft.satisfaction, [name]: value as number } });
    }
  };

  const renderConfidenceBadge = (key: string) => {
    const level = draft.confidence?.[key] || 'low';
    const styleMap = {
      high: { border: '#bfe3d2', text: 'var(--success)', bg: 'var(--success-bg)' },
      medium: { border: '#f5d29a', text: 'var(--warning)', bg: 'var(--warning-bg)' },
      low: { border: '#f0b7b2', text: 'var(--error)', bg: 'var(--error-bg)' },
    };
    const style = styleMap[level];

    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          minHeight: 24,
          padding: '2px 8px',
          borderRadius: 999,
          border: `1px solid ${style.border}`,
          color: style.text,
          background: style.bg,
          fontSize: 12,
          fontWeight: 700,
          marginLeft: 8,
          whiteSpace: 'nowrap',
        }}
      >
        {confidenceLabel[level]}
      </span>
    );
  };

  const getConfidenceLevel = (key: string): 'high' | 'medium' | 'low' => {
    return draft.confidence?.[key] || 'low';
  };

  const getFieldCardStyle = (key: string): React.CSSProperties => {
    const level = getConfidenceLevel(key);
    const hasSaveError = saveErrors.some((error) => error.field === key);

    if (hasSaveError) {
      return {
        border: '2px solid var(--error)',
        background: 'var(--error-bg)',
        borderRadius: 8,
        padding: 11,
        boxShadow: '0 0 0 3px rgba(216, 48, 36, 0.16)',
      };
    }

    // Confidence is what the recognizer thought before anyone looked, and it
    // never changes. A field the reviewer has answered therefore kept its red
    // or amber card, so a screen that had been fully worked through still read
    // as a screen full of problems. Once it is settled, the only thing worth
    // saying about it is that it is settled.
    if (isSettled(key)) {
      return {
        border: '1px solid #ccd2dc',
        background: '#eef1f5',
        borderRadius: 8,
        padding: 12,
      };
    }

    if (contestedUnconfirmedFieldSet.has(key)) {
      return {
        border: '2px solid #d97706',
        background: '#fff7ed',
        borderRadius: 8,
        padding: 11,
      };
    }

    if (level === 'low') {
      return {
        border: '1px solid #f0b7b2',
        background: 'var(--error-bg)',
        borderRadius: 8,
        padding: 12,
      };
    }

    if (level === 'medium') {
      return {
        border: '1px solid #f5d29a',
        background: 'var(--warning-bg)',
        borderRadius: 8,
        padding: 12,
      };
    }

    return {
      border: '1px solid var(--border-subtle)',
      background: 'var(--surface-muted)',
      borderRadius: 8,
      padding: 12,
    };
  };

  const renderCandidateSummary = (key: string) => {
    const candidates = draft.candidates?.[key]?.slice(0, 3);
    if (!candidates || candidates.length === 0) return null;

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {candidates.map((candidate, index) => (
          <span
            key={`${key}-${candidate.value}-${index}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 24,
              padding: '2px 7px',
              borderRadius: 6,
              border: index === 0 ? '1px solid var(--brand-primary)' : '1px solid var(--border-medium)',
              background: index === 0 ? 'var(--brand-soft)' : '#ffffff',
              color: index === 0 ? 'var(--brand-primary-active)' : 'var(--text-muted)',
              fontSize: 12,
              fontWeight: index === 0 ? 800 : 600,
            }}
            title={`score ${candidate.score}`}
          >
            {String(candidate.value)} / {Math.round(candidate.score * 100)}%
          </span>
        ))}
      </div>
    );
  };

  const imageUrl = (imageId?: string) => {
    if (!imageId) return '';
    if (imageId === draft.source?.satisfactionImageId) {
      return draft.source?.satisfactionImageDataUrl || '';
    }
    return draft.source?.cagiImageDataUrl || '';
  };

  const cropUrl = (key: string, debug = false) => {
    return debug
      ? draft.source?.cropDebugDataUrls?.[key] || ''
      : draft.source?.cropDataUrls?.[key] || '';
  };

  const renderRoiBoxToggle = () => (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 700,
        color: 'var(--text-secondary, #555)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* globals.css styles every `input` as a full-width form field, which
          stretched this checkbox to the width of the panel and pushed the label
          off the right edge of the page. Size it explicitly. */}
      <input
        type="checkbox"
        checked={showRoiBoxes}
        onChange={(e) => setShowRoiBoxes(e.target.checked)}
        style={{ cursor: 'pointer', flexShrink: 0, width: 16, height: 16, minHeight: 0, margin: 0 }}
      />
      {/* nowrap so the label can never be squeezed to zero width and vanish,
          which is what happened while it shared the header row. */}
      <span style={{ whiteSpace: 'nowrap' }}>인식 영역 상자 표시</span>
    </label>
  );

  const renderDiagnosticsToggle = () => (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 700,
        color: 'var(--text-secondary, #555)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <input
        type="checkbox"
        checked={showDiagnostics}
        onChange={(e) => setShowDiagnostics(e.target.checked)}
        style={{ cursor: 'pointer', flexShrink: 0, width: 16, height: 16, minHeight: 0, margin: 0 }}
      />
      <span style={{ whiteSpace: 'nowrap' }}>기술 진단 표시</span>
    </label>
  );

  /**
   * Moving between students without saving, in both directions.
   *
   * Forward is the skip: this student's row is simply never written. Backward
   * is the repair: noticing at student twelve that student nine was wrong used
   * to mean discarding the batch, because the index only ever counted up.
   */
  const renderStudentNav = () => {
    const canPrev = currentIndex > 1;
    const canNext = currentIndex < totalCount;
    const navButton = (label: string, target: number, enabled: boolean, title: string) => (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => onNavigate?.(target)}
        disabled={!enabled || isSaving}
        title={title}
        style={{
          whiteSpace: 'nowrap',
          fontSize: 13,
          padding: '6px 12px',
          minHeight: 34,
          flexShrink: 0,
          opacity: enabled ? 1 : 0.45,
          cursor: enabled ? 'pointer' : 'not-allowed',
        }}
      >
        {label}
      </button>
    );

    return (
      <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {navButton('← 이전 학생', currentIndex - 2, canPrev, canPrev
          ? '저장하지 않고 이전 학생으로 돌아갑니다.'
          : '첫 번째 학생입니다.')}
        {navButton('다음 학생 →', currentIndex, canNext, canNext
          ? '저장하지 않고 다음 학생으로 넘어갑니다.'
          : '마지막 학생입니다.')}
      </div>
    );
  };

  /**
   * The attention field's one-click disposal.
   *
   * Shown only where there is a value to accept: a blank field needs an answer,
   * and picking one already marks it settled through the normal change path.
   */
  const renderConfirmButton = (key: string) => {
    if (confidenceRank[getConfidenceLevel(key)] === 0 && !needsValue(key) && !unconfirmedMachineFieldSet.has(key)) return null;
    if (isSettled(key)) return null;
    const empty = needsValue(key);

    return (
      <button
        type="button"
        onClick={() => confirmField(key)}
        style={{
          marginTop: 8,
          padding: '5px 12px',
          fontSize: 12,
          fontWeight: 700,
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid #bfe3d2',
          color: 'var(--success)',
          background: 'var(--success-bg)',
        }}
      >
        {empty ? '비어 있는 것이 맞음' : '이 값이 맞음'}
      </button>
    );
  };

  /**
   * Picks the suggested option, through the ordinary manual-change path.
   *
   * Deliberately not a route of its own: the result is exactly what choosing
   * that option in the `select` produces, including the `수기 수정` label. A
   * value that arrives here is a person's, and the record says so.
   */
  const applySuggestion = (key: string, value: number | string) => {
    const [group, name] = key.split('.');
    if (group === 'basic') {
      handleBasicChange(name, value);
    } else if (group === 'cagi') {
      handleCagiChange(name, Number(value));
    } else {
      handleSatisfactionChange(name, Number(value));
    }
  };

  /**
   * The default the reviewer confirms, on a field the recognizer refused.
   *
   * Measured at ~83% (FIELD_TEST §31 and the central three-set run), which is
   * why it is offered rather than filled in: 17% wrong would be stored as if a
   * person had verified it. So this changes nothing about the field's state --
   * the control stays empty, `needsValue` stays true, the card keeps its colour
   * and the field keeps its place in `확인 필요`. It only saves the reviewer
   * from picking out of four when they already agree with the guess.
   *
   * Two placement decisions follow from the same worry, that a default which is
   * usually right trains people to stop looking:
   *
   * - It renders *after* the crop image, not next to the control. The reviewer
   *   scrolls past the photograph of the actual paper to reach it, so the
   *   evidence is on screen before the guess is reachable.
   * - It is the quietest interactive thing in the card: a dashed outline in
   *   neutral grey, against a card that is already red or amber. Confirm stays
   *   the green one. Nothing here competes with the scan for attention.
   */
  const renderReviewSuggestion = (key: string) => {
    const suggestion = draft.source?.recognitionSuggestion?.[key];
    if (!suggestion) return null;
    // Never over an answer that is already there, and never once the reviewer
    // has dealt with the field -- at that point it would be second-guessing a
    // person who has looked at the paper.
    if (!needsValue(key) || isSettled(key)) return null;
    const label = suggestionOptionLabels(key)?.[String(suggestion.value)];
    // An option this screen cannot name is one it should not offer.
    if (!label) return null;

    return (
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => applySuggestion(key, suggestion.value)}
          title="자동 입력 기준에는 미치지 못하는 추정입니다. 종이를 보고 확인해주세요."
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 700,
            borderRadius: 6,
            cursor: 'pointer',
            border: '1px dashed #b9c1cd',
            background: '#ffffff',
            color: '#4b5565',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 6px',
              borderRadius: 999,
              border: '1px solid #d8dde8',
              background: '#f6f8fb',
              color: '#667085',
              fontSize: 11,
              fontWeight: 800,
            }}
          >
            추천
          </span>
          {label}
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, lineHeight: 1.35 }}>
          이 칸일 가능성이 높습니다 — 확인해주세요
        </span>
      </div>
    );
  };

  const renderCropSourceBadge = (key: string) => {
    const description = describeCropSource(draft, key);
    if (!description) return null;
    const diagnostic = showDiagnostics ? draft.source?.recognitionCropDiagnostic?.[key] : undefined;
    const registration = draft.source?.recognitionRegistration?.[key];

    return (
      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 22,
            padding: '2px 7px',
            borderRadius: 999,
            border: '1px solid #d8dde8',
            color: '#4b5565',
            background: '#f6f8fb',
            fontSize: 11,
            fontWeight: 800,
            whiteSpace: 'nowrap',
          }}
        >
          {description.sourceLabel}
        </span>
        {description.registrationLabel && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 22,
              padding: '2px 7px',
              borderRadius: 999,
              border: description.registrationStatus === 'verified' ? '1px solid #9fdfc5' : '1px solid #f3c38f',
              color: description.registrationStatus === 'verified' ? '#177245' : '#9a5a11',
              background: description.registrationStatus === 'verified' ? '#eefaf3' : '#fff8e7',
              fontSize: 11,
              fontWeight: 800,
              whiteSpace: 'nowrap',
            }}
            title={registration?.tableId}
          >
            {description.registrationLabel}
          </span>
        )}
        {diagnostic && (
          <span style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
            {diagnostic}
          </span>
        )}
      </span>
    );
  };

  const evidenceCandidateLabels = (key: string): string[] => {
    const labels = suggestionOptionLabels(key);
    if (labels) return Object.keys(labels);
    return (draft.candidates?.[key] || []).map((candidate) => String(candidate.value));
  };

  const renderRecognitionEvidence = (key: string) => {
    const evidence = draft.source?.recognitionEvidence?.[key];
    if (!evidence) return null;
    const causes = remarkCause(evidence);
    const causeLabels: Record<typeof causes[number], string> = {
      faint: '흐림',
      offset: '자리 이탈',
      shape: '모양 이상',
    };

    return (
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
        <span style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
          {describeEvidence(evidence, evidenceCandidateLabels(key))}
        </span>
        {causes.map((cause) => (
          <span
            key={`${key}-${cause}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 19,
              padding: '1px 6px',
              borderRadius: 999,
              border: '1px solid #d8dde8',
              color: '#667085',
              background: '#f6f8fb',
              fontSize: 10,
              fontWeight: 800,
              whiteSpace: 'nowrap',
            }}
          >
            {causeLabels[cause]}
          </span>
        ))}
      </div>
    );
  };

  const renderValueSourceBadge = (key: string) => {
    const source = draft.source?.recognitionValueSource?.[key] || 'unresolved';
    const contested = (source === 'auto' || source === 'restored')
      && draft.source?.recognitionContested?.[key] === true;
    const manualEditedAt = draft.source?.recognitionManualEditedAt?.[key];
    const styleMap: Record<string, { border: string; text: string; bg: string; label: string }> = {
      auto: { border: '#9fdfc5', text: '#177245', bg: '#eefaf3', label: '자동 인식 · 확인 필요' },
      manual: { border: '#b9c8f3', text: '#405aa8', bg: '#f2f5ff', label: '수기 수정' },
      unresolved: { border: '#d8dde8', text: '#667085', bg: '#f6f8fb', label: '미확정' },
      restored: { border: '#c7ced8', text: '#52606d', bg: '#f1f4f7', label: '저장값 복원 · 확인 필요' },
    };
    Object.assign(styleMap, {
      confirmed: { ...styleMap.manual, label: '\uD655\uC778 \uC644\uB8CC' },
      blank_ok: { ...styleMap.manual, label: '\uBE48\uCE78 \uD655\uC778' },
    });
    const style = styleMap[source] || styleMap.unresolved;
    const title = manualEditedAt
      ? `수기 수정 시각: ${new Date(manualEditedAt).toLocaleString('ko-KR')}`
      : source === 'auto'
        ? '자동 인식값이므로 사람이 확인해야 저장할 수 있습니다.'
        : source === 'restored'
          ? '저장된 값이지만 확인이 필요합니다.'
          : '자동 인식값이 확정되지 않아 검수가 필요합니다.';

    return (
      <>
        <span
          title={title}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 24,
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${style.border}`,
            color: style.text,
            background: style.bg,
            fontSize: 12,
            fontWeight: 700,
            marginLeft: 6,
            whiteSpace: 'nowrap',
          }}
        >
          {style.label}
        </span>
        {contested && (
          <span
            title="다른 칸에도 표시 흔적이 있습니다 — 지운 표시인지 확인해주세요"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 24,
              padding: '2px 8px',
              borderRadius: 999,
              border: '1px solid #f5d29a',
              color: 'var(--warning)',
              background: 'var(--warning-bg)',
              fontSize: 12,
              fontWeight: 700,
              marginLeft: 6,
              whiteSpace: 'nowrap',
            }}
          >
            경합
          </span>
        )}
      </>
    );
  };

  const openDataUrlInNewTab = async (event: React.MouseEvent, dataUrl: string) => {
    event.preventDefault();
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const newTab = window.open(blobUrl, '_blank', 'noopener,noreferrer');
      if (newTab) {
        newTab.addEventListener('load', () => URL.revokeObjectURL(blobUrl));
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      // If conversion fails for any reason, do nothing rather than crash -- the inline
      // <img> preview already shows the image, this is only the "open larger" affordance.
    }
  };

  const renderFieldCropPreview = (key: string) => {
    if (!draft.candidates?.[key]?.length && key !== 'basic.age') return null;

    const url = cropUrl(key);
    const debugUrl = cropUrl(key, true);
    // The reviewer's first job is to read what the respondent actually marked,
    // and the annotated version covers the answer cells with boxes, labels, and
    // a crosshair. Default to the plain crop and let the header toggle bring the
    // boxes back when the question is "where did the recognizer look?" instead.
    // Both crops are already in the response, so neither costs extra payload.
    const inlineUrl = (showRoiBoxes ? debugUrl : url) || debugUrl || url;
    const roiUrl = debugUrl || url;
    if (!inlineUrl) {
      return (
        <div
          role="note"
          style={{
            marginTop: 8,
            padding: '7px 9px',
            border: '1px dashed #d8dde8',
            borderRadius: 6,
            background: '#f6f8fb',
            color: '#667085',
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          원본 크롭이 캐시에 없습니다(4시간 경과 또는 새 기기). 원본 이미지에서 확인하세요.
        </div>
      );
    }

    return (
      <div style={{ marginTop: 8 }}>
        <a
          href={inlineUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => openDataUrlInNewTab(e, inlineUrl)}
          style={{
            display: 'block',
            border: '1px solid var(--border-medium)',
            borderRadius: 6,
            overflow: 'hidden',
            background: '#ffffff',
          }}
        >
          <img
            src={inlineUrl}
            alt={`${key} crop ROI`}
            loading="lazy"
            style={{
              width: '100%',
              height: 72,
              display: 'block',
              objectFit: 'contain',
              background: '#ffffff',
            }}
          />
        </a>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 5 }}>
          <a
            href={roiUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => openDataUrlInNewTab(e, roiUrl)}
            style={{
              color: 'var(--brand-primary-active)',
              fontSize: 12,
              fontWeight: 800,
              textDecoration: 'none',
            }}
          >
            ROI 확인
          </a>
        </div>
      </div>
    );
  };

  const renderSourcePreview = () => {
    const cagiImageUrl = imageUrl(draft.source?.cagiImageId);
    const satisfactionImageUrl = imageUrl(draft.source?.satisfactionImageId);

    if (!cagiImageUrl && !satisfactionImageUrl) {
      return null;
    }

    const previewItems = [
      { label: '선별검사지', url: cagiImageUrl },
      { label: '만족도조사', url: satisfactionImageUrl },
    ].filter((item) => item.url);

    return (
      <div>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>원본 이미지</h3>
        <div className="source-preview-grid">
          {previewItems.map((item) => (
            <a
              key={item.label}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => openDataUrlInNewTab(e, item.url)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-secondary)' }}>{item.label}</span>
              <span
                style={{
                  display: 'block',
                  height: 220,
                  border: '1px solid var(--border-medium)',
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: '#ffffff',
                }}
              >
                <img
                  src={item.url}
                  alt={`${item.label} 원본 이미지`}
                  style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    objectFit: 'contain',
                    background: '#ffffff',
                  }}
                />
              </span>
            </a>
          ))}
        </div>
      </div>
    );
  };

  const reviewKeys = [
    'basic.age', 'basic.gender', 'basic.schoolType', 'basic.grade',
    ...Array.from({ length: 9 }).map((_, idx) => `cagi.q${String(idx + 1).padStart(2, '0')}`),
    ...Array.from({ length: 10 }).map((_, idx) => `satisfaction.q${String(idx + 1).padStart(2, '0')}`),
  ];
  /**
   * A field with no value needs the reviewer whatever the recogniser thought of
   * it. Confidence alone missed that: school type and grade come back `높음`
   * and unfilled on real pages -- the scorer was sure and the gate still
   * refused -- so they stayed out of the outstanding list, off the jump row,
   * and out of the count. A reviewer could clear every highlighted item, read
   * "모두 확인했습니다", and save the student with two fields empty.
   */
  const needsValue = (key: string) => {
    const value = currentValue(key);
    return value === undefined || value === null || value === '';
  };
  const attentionFields = reviewKeys.filter(
    (key) => confidenceRank[getConfidenceLevel(key)] > 0 || needsValue(key) || unconfirmedMachineFieldSet.has(key),
  );
  // What is still outstanding, in the order the fields appear on the page, so
  // "next" always moves down the screen and never jumps backwards.
  const pendingFields = attentionFields.filter((key) => !isSettled(key));
  const settledCount = attentionFields.length - pendingFields.length;
  const lowCount = pendingFields.filter((key) => getConfidenceLevel(key) === 'low').length;
  const mediumCount = pendingFields.filter((key) => getConfidenceLevel(key) === 'medium').length;
  const firstUnconfirmedFieldKey = contestedUnconfirmedFieldKeys[0] || unconfirmedMachineFieldKeys[0];
  const saveErrorKeys = Array.from(
    new Set(saveErrors.flatMap((error) => (error.field ? [error.field] : []))),
  );

  const fieldLabel = (key: string) => {
    const basicLabels: Record<string, string> = {
      'basic.age': '연령대',
      'basic.gender': '성별',
      'basic.schoolType': '학교유형',
      'basic.grade': '학년',
    };
    if (basicLabels[key]) return basicLabels[key];

    const cagiMatch = key.match(/^cagi\.q(\d{2})$/);
    if (cagiMatch) return `CAGI ${cagiMatch[1]}`;

    const satisfactionMatch = key.match(/^satisfaction\.q(\d{2})$/);
    if (satisfactionMatch) {
      const number = Number(satisfactionMatch[1]);
      if (number === 1) return '문항1 교육 참여 횟수';
      if (number <= 6) return `문항${number} 예/아니오`;
      return `문항${number} 만족도`;
    }

    return key;
  };

  const renderDecisionTrace = (key: string) => {
    if (!showDiagnostics) return null;
    const trace = draft.source?.recognitionDecisionTrace?.[key];
    if (!trace) return null;

    return (
      <p
        style={{
          margin: '8px 0 0',
          color: 'var(--text-muted)',
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.4,
          overflowWrap: 'anywhere',
        }}
      >
        {trace}
      </p>
    );
  };

  /**
   * Per-sheet capture verdict strip (spec F3).
   *
   * The reviewer's first question about a wrong-looking student is whether the
   * photo was any good, and until now the answer only existed at upload time,
   * on a screen they had already left. This shows the same verdict the upload
   * panel showed, in the same words, next to the values it produced -- and it
   * marks a sheet the user pushed past a retake prompt (F2.3), because that is
   * the sheet whose values deserve a second look.
   *
   * Display only. It reads the draft's attachment and nothing else; no value,
   * gate, or threshold is touched.
   */
  const renderSheetQuality = () => {
    const badges = buildSheetQualityBadges(draft.sheetQuality);
    // Nothing measured -- an old draft, or a scan that carries no capture
    // metadata. An empty strip is the honest rendering: absence must not read
    // as a passing verdict.
    if (badges.length === 0) return null;

    const worst = badges.some((badge) => badge.level === 'unusable') ? 'unusable'
      : badges.some((badge) => badge.level === 'retake-suggested') ? 'retake-suggested'
        : 'good';

    // `notice` is amber and `error-box` is red, and on this screen both mean
    // "there is something here for you". An all-clear verdict in an amber box
    // would say the opposite of what it means, so it gets the same neutral
    // surface a settled field card uses.
    const neutralBox: React.CSSProperties = {
      border: '1px solid var(--border-subtle)',
      background: 'var(--surface-muted)',
      borderRadius: 8,
      padding: '14px 16px',
      fontSize: 14,
      lineHeight: 1.55,
    };

    return (
      <div
        className={worst === 'unusable' ? 'error-box' : worst === 'retake-suggested' ? 'notice' : undefined}
        role="status"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          ...(worst === 'good' ? neutralBox : {}),
        }}
      >
        <strong>촬영 상태 판정</strong>
        {badges.map((badge) => {
          const style = sheetQualityBadgeStyle[badge.level];
          return (
            <div
              key={badge.side}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
            >
              <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{badge.sideLabel}</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 24,
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: `1px solid ${style.border}`,
                  color: style.text,
                  background: style.bg,
                  fontSize: 12,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                {badge.label}
              </span>
              {badge.hint && (
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{badge.hint}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const formatPercent = (value?: number) => value === undefined
    ? '-'
    : `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;

  const renderCoordinateDiagnostics = () => {
    if (!showDiagnostics) return null;
    const registrations = draft.source?.recognitionRegistration;
    const valueSources = draft.source?.recognitionValueSource;
    const decisionTraces = draft.source?.recognitionDecisionTrace;
    if (!registrations && !valueSources && !decisionTraces) return null;

    const entries = reviewKeys
      .filter((key) => (
        registrations?.[key]
        || draft.source?.recognitionCropSource?.[key]
        || valueSources?.[key]
        || decisionTraces?.[key]
      ))
      .map((key) => ({
        key,
        registration: registrations?.[key],
        source: draft.source?.recognitionCropSource?.[key],
        diagnostic: draft.source?.recognitionCropDiagnostic?.[key],
        valueSource: valueSources?.[key] || 'unresolved',
        decisionTrace: decisionTraces?.[key],
      }));

    if (entries.length === 0) return null;

    return (
      <details
        style={{
          border: '1px solid var(--border-medium)',
          borderRadius: 8,
          background: 'var(--surface-muted)',
          padding: '10px 12px',
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 800, fontSize: 14 }}>
          좌표 진단 데이터 ({entries.length}개 항목)
        </summary>
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {entries.map(({ key, registration, source, diagnostic, valueSource, decisionTrace }) => {
            const horizontal = registration?.horizontalLines;
            const vertical = registration?.verticalLines;
            const gap = registration?.gapDeviation;
            const residual = registration?.residualRatio;
            const offset = registration?.candidateCenterOffset;
            const spread = registration?.candidateCenterSpread;

            return (
              <div
                key={key}
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  padding: 9,
                  background: '#ffffff',
                  fontSize: 12,
                  lineHeight: 1.5,
                  overflowWrap: 'anywhere',
                }}
              >
                <strong>{fieldLabel(key)}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}| {source ? cropSourceLabel[source] : '좌표 정보 없음'}
                    {' '}| {
                    valueSource === 'auto'
                      ? '자동 인식 · 확인 필요'
                      : valueSource === 'manual'
                        ? '수기 수정'
                        : valueSource === 'confirmed'
                          ? '확인 완료'
                          : valueSource === 'blank_ok'
                            ? '빈칸 확인'
                            : valueSource === 'restored'
                              ? '저장값 복원 · 확인 필요'
                              : '미확정'
                  }
                  {registration ? ` | ${registration.tableId} / ${registration.status}` : ''}
                </span>
                {horizontal && vertical && (
                  <div>
                    감지선: 가로 {horizontal.found}/{horizontal.expected}, 세로 {vertical.found}/{vertical.expected}
                  </div>
                )}
                {(gap || residual || offset || spread) && (
                  <div>
                    간격: Y {formatPercent(gap?.rows)}, X {formatPercent(gap?.columns)}
                    {' | '}잔차: Y {formatPercent(residual?.rows)}, X {formatPercent(residual?.columns)}
                    {' | '}중심 오프셋: X {formatPercent(offset?.x)}, Y {formatPercent(offset?.y)}
                    {' | '}흩어짐: X {formatPercent(spread?.x)}, Y {formatPercent(spread?.y)}
                  </div>
                )}
                {diagnostic && <div style={{ color: 'var(--text-muted)' }}>{diagnostic}</div>}
                {decisionTrace && <div style={{ color: 'var(--text-muted)' }}>{decisionTrace}</div>}
              </div>
            );
          })}
        </div>
      </details>
    );
  };

  const saveErrorMessages = saveErrors.filter((error) => !error.field);

  const fieldShell = (label: string, badgeKey: string, control: React.ReactNode) => (
    <div id={fieldDomId(badgeKey)} style={getFieldCardStyle(badgeKey)}>
      <label style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 7 }}>
        {label}
        {renderConfidenceBadge(badgeKey)}
        {renderValueSourceBadge(badgeKey)}
      </label>
      {control}
      {renderCandidateSummary(badgeKey)}
      {renderCropSourceBadge(badgeKey)}
      {renderRecognitionEvidence(badgeKey)}
      {renderFieldCropPreview(badgeKey)}
      {renderReviewSuggestion(badgeKey)}
      {renderDecisionTrace(badgeKey)}
      {renderConfirmButton(badgeKey)}
    </div>
  );

  return (
    <section className="panel panel-pad animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 22, marginBottom: 6 }}>인식 결과 검수</h2>
          {/* Two explicit lines rather than one long sentence, so the title
              block claims about half the row instead of all of it. */}
          <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.45, margin: 0 }}>
            <span style={{ display: 'block' }}>{currentIndex} / {totalCount}번째 학생 데이터입니다.</span>
            <span style={{ display: 'block' }}>저장 전 값을 확인해주세요.</span>
          </p>
        </div>
        <button
          className="btn-secondary"
          type="button"
          onClick={onReset}
          style={{ whiteSpace: 'nowrap', fontSize: 13, padding: '8px 12px', minHeight: 38, flexShrink: 0 }}
        >
          검수 취소
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
        {renderRoiBoxToggle()}
        {renderDiagnosticsToggle()}
        {onNavigate && renderStudentNav()}
      </div>

      {savedRow >= 0 && (
        <div
          className={hasUnsavedEdits ? 'error-box' : 'notice'}
          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <strong>
            이미 저장된 학생입니다 · 엑셀 {3 + savedRow}행
            {hasUnsavedEdits ? ' · 저장되지 않은 수정 있음' : ''}
          </strong>
          <span>
            {hasUnsavedEdits
              ? '아래 버튼을 눌러야 엑셀에 반영됩니다. 그냥 이동하면 엑셀에는 이전 값이 남습니다.'
              : '다시 저장하면 새 행이 생기지 않고 같은 행을 덮어씁니다.'}
          </span>
        </div>
      )}

      {renderSheetQuality()}

      {attentionFields.length > 0 && (
        <div
          className={pendingFields.length === 0 ? 'notice' : lowCount > 0 ? 'error-box' : 'notice'}
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {pendingFields.length === 0 ? (
            <strong>확인 필요 항목 {attentionFields.length}개를 모두 확인했습니다.</strong>
          ) : (
            <>
              <strong>
                확인 필요 항목 {attentionFields.length}개 중 {settledCount}개 완료 · {pendingFields.length}개 남음
              </strong>
              {contestedUnconfirmedFieldKeys.length > 0 && (
                <span style={{ color: '#b45309', fontWeight: 700 }}>
                  <strong>경합 {contestedUnconfirmedFieldKeys.length}개</strong> — 표시가 비슷해 잘못 고를 수 있었던 항목입니다. 먼저 확인하세요.
                </span>
              )}
              <span>
                낮은 신뢰도 {lowCount}개, 확인 권장 {mediumCount}개입니다. 아래에서 항목을 눌러 바로 이동할 수 있습니다.
                {unconfirmedMachineFieldKeys.length > 0 && (
                  <> 확인되지 않은 자동 입력 {unconfirmedMachineFieldKeys.length}개도 포함되어 있습니다.</>
                )}
              </span>
              {/* The whole point of this row. Nineteen students at four or five
                  fields each is a lot of scrolling to find highlighted cards
                  among twenty-three, and until now the only guide was the
                  colour of the border. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => focusField(pendingFields[0])}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  남은 항목으로 이동
                </button>
                {pendingFields.map((key) => {
                  const contested = contestedUnconfirmedFieldSet.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => focusField(key)}
                      title={`${fieldLabel(key)}${contested ? ' · 경합' : ''}(으)로 이동`}
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: contested ? 800 : 700,
                        borderRadius: 999,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        border: contested
                          ? '2px solid #d97706'
                          : `1px solid ${getConfidenceLevel(key) === 'low' ? '#f0b7b2' : '#f5d29a'}`,
                        color: contested
                          ? '#b45309'
                          : getConfidenceLevel(key) === 'low' ? 'var(--error)' : 'var(--warning)',
                        background: contested
                          ? '#fff7ed'
                          : getConfidenceLevel(key) === 'low' ? 'var(--error-bg)' : 'var(--warning-bg)',
                      }}
                    >
                      {contested ? `경합 · ${fieldLabel(key)}` : fieldLabel(key)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {draft.warnings?.map((warning) => (
        <div key={warning} className="notice" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>자동 인식 안내</strong>
          <span>{warning}</span>
        </div>
      ))}

      {renderCoordinateDiagnostics()}

      {renderSourcePreview()}

      <div>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>기본정보</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
          {fieldShell(
            '연령대',
            'basic.age',
            <input
              type="number"
              value={draft.basic.age || ''}
              onChange={(e) => handleBasicChange('age', e.target.value ? parseInt(e.target.value, 10) : '')}
            />,
          )}
          {fieldShell(
            '성별',
            'basic.gender',
            <select value={draft.basic.gender || ''} onChange={(e) => handleBasicChange('gender', e.target.value)}>
              <option value="">선택 안 함</option>
              <option value="남">남</option>
              <option value="여">여</option>
            </select>,
          )}
          {fieldShell(
            '학교유형',
            'basic.schoolType',
            <select value={draft.basic.schoolType || ''} onChange={(e) => handleBasicChange('schoolType', e.target.value)}>
              <option value="">선택 안 함</option>
              <option value="초등학교">초등학교</option>
              <option value="중학교">중학교</option>
              <option value="고등학교">고등학교</option>
              <option value="학교외기관">학교외기관</option>
            </select>,
          )}
          {fieldShell(
            '학년',
            'basic.grade',
            <select value={draft.basic.grade || ''} onChange={(e) => handleBasicChange('grade', e.target.value)}>
              <option value="">선택 안 함</option>
              <option value="1학년">1학년</option>
              <option value="2학년">2학년</option>
              <option value="3학년">3학년</option>
              <option value="4학년">4학년</option>
              <option value="5학년">5학년</option>
              <option value="6학년">6학년</option>
              <option value="해당없음">해당없음</option>
            </select>,
          )}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>도박문제 선별검사 CAGI</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {Array.from({ length: 9 }).map((_, idx) => {
            const num = String(idx + 1).padStart(2, '0');
            const key = `q${num}`;
            const val = draft.cagi[key];

            return (
              <div key={key} id={fieldDomId(`cagi.q${num}`)} style={getFieldCardStyle(`cagi.q${num}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  CAGI {num}
                  {renderConfidenceBadge(`cagi.q${num}`)}
                  {renderValueSourceBadge(`cagi.q${num}`)}
                </label>
                <select value={val !== undefined ? val : ''} onChange={(e) => handleCagiChange(key, parseInt(e.target.value, 10))}>
                  <option value="">선택</option>
                  <option value="0">0 없다</option>
                  <option value="1">1 가끔 있다</option>
                  <option value="2">2 자주 있다</option>
                  <option value="3">3 거의 항상 있다</option>
                </select>
                {renderCandidateSummary(`cagi.q${num}`)}
                {renderCropSourceBadge(`cagi.q${num}`)}
                {renderRecognitionEvidence(`cagi.q${num}`)}
                {renderFieldCropPreview(`cagi.q${num}`)}
                {renderReviewSuggestion(`cagi.q${num}`)}
                {renderDecisionTrace(`cagi.q${num}`)}
      {renderConfirmButton(`cagi.q${num}`)}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>예방교육 만족도조사</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div id={fieldDomId('satisfaction.q01')} style={getFieldCardStyle('satisfaction.q01')}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
              문항1 교육 참여 횟수
              {renderConfidenceBadge('satisfaction.q01')}
              {renderValueSourceBadge('satisfaction.q01')}
            </label>
            <select value={draft.satisfaction.q01 !== undefined ? draft.satisfaction.q01 : ''} onChange={(e) => handleSatisfactionChange('q01', parseInt(e.target.value, 10))}>
              <option value="">선택</option>
              <option value="1">1 없음</option>
              <option value="2">2 1회</option>
              <option value="3">3 2회</option>
              <option value="4">4 3회 이상</option>
            </select>
            {renderCandidateSummary('satisfaction.q01')}
            {renderCropSourceBadge('satisfaction.q01')}
            {renderRecognitionEvidence('satisfaction.q01')}
            {renderFieldCropPreview('satisfaction.q01')}
            {renderReviewSuggestion('satisfaction.q01')}
            {renderDecisionTrace('satisfaction.q01')}
      {renderConfirmButton('satisfaction.q01')}
          </div>

          {Array.from({ length: 5 }).map((_, idx) => {
            const num = idx + 2;
            const key = `q0${num}`;
            const val = draft.satisfaction[key];

            return (
              <div key={key} id={fieldDomId(`satisfaction.q0${num}`)} style={getFieldCardStyle(`satisfaction.q0${num}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  문항{num} 예/아니오
                  {renderConfidenceBadge(`satisfaction.q0${num}`)}
                  {renderValueSourceBadge(`satisfaction.q0${num}`)}
                </label>
                <select value={val !== undefined ? val : ''} onChange={(e) => handleSatisfactionChange(key, parseInt(e.target.value, 10))}>
                  <option value="">선택</option>
                  <option value="0">0 아니오</option>
                  <option value="1">1 예</option>
                </select>
                {renderCandidateSummary(`satisfaction.q0${num}`)}
                {renderCropSourceBadge(`satisfaction.q0${num}`)}
                {renderRecognitionEvidence(`satisfaction.q0${num}`)}
                {renderFieldCropPreview(`satisfaction.q0${num}`)}
                {renderReviewSuggestion(`satisfaction.q0${num}`)}
                {renderDecisionTrace(`satisfaction.q0${num}`)}
      {renderConfirmButton(`satisfaction.q0${num}`)}
              </div>
            );
          })}

          {Array.from({ length: 4 }).map((_, idx) => {
            const num = idx + 7;
            const key = num === 10 ? 'q10' : `q0${num}`;
            const val = draft.satisfaction[key];

            return (
              <div key={key} id={fieldDomId(`satisfaction.${key}`)} style={getFieldCardStyle(`satisfaction.${key}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  문항{num} 만족도
                  {renderConfidenceBadge(`satisfaction.${key}`)}
                  {renderValueSourceBadge(`satisfaction.${key}`)}
                </label>
                <select value={val !== undefined ? val : ''} onChange={(e) => handleSatisfactionChange(key, parseInt(e.target.value, 10))}>
                  <option value="">선택</option>
                  <option value="0">0 매우 그렇지 않다</option>
                  <option value="1">1 그렇지 않다</option>
                  <option value="2">2 보통이다</option>
                  <option value="3">3 그렇다</option>
                  <option value="4">4 매우 그렇다</option>
                </select>
                {renderCandidateSummary(`satisfaction.${key}`)}
                {renderCropSourceBadge(`satisfaction.${key}`)}
                {renderRecognitionEvidence(`satisfaction.${key}`)}
                {renderFieldCropPreview(`satisfaction.${key}`)}
                {renderReviewSuggestion(`satisfaction.${key}`)}
                {renderDecisionTrace(`satisfaction.${key}`)}
      {renderConfirmButton(`satisfaction.${key}`)}
              </div>
            );
          })}
        </div>
      </div>

      {saveErrors.length > 0 && (
        <div className="error-box" role="alert" aria-live="assertive">
          <strong>
            {saveErrorKeys.length > 0
              ? `필수 항목 ${saveErrorKeys.length}개가 비어 있어 저장하지 못했습니다.`
              : '저장하지 못했습니다.'}
          </strong>
          {saveErrorKeys.length > 0 && (
            <div style={{ marginTop: 6 }}>
              확인할 항목: {saveErrorKeys.map(fieldLabel).join(', ')}
            </div>
          )}
          {saveErrorMessages.map((error, index) => (
            <div key={`${error.code}-${index}`} style={{ marginTop: 6 }}>
              {error.message}
            </div>
          ))}
        </div>
      )}

      {unconfirmedMachineFieldKeys.length > 0 && (
        <div
          className="error-box"
          role="alert"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}
        >
          <strong>
            확인되지 않은 자동 입력 {unconfirmedMachineFieldKeys.length}개 — 확인 후 저장할 수 있습니다
          </strong>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              if (firstUnconfirmedFieldKey) focusField(firstUnconfirmedFieldKey);
            }}
            style={{ padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
          >
            {contestedUnconfirmedFieldKeys.length > 0
              ? '첫 번째 경합 항목으로 이동'
              : '첫 번째 미확정 항목으로 이동'}
          </button>
        </div>
      )}

      <button
        className="btn-primary"
        style={{ width: '100%' }}
        disabled={isSaving || unconfirmedMachineFieldKeys.length > 0}
        onClick={onSave}
      >
        {isSaving
          ? '엑셀 반영 및 검증 중'
          : savedRow >= 0
            ? `수정 내용 반영 (엑셀 ${3 + savedRow}행)`
            : '검수 완료 및 엑셀 반영'}
      </button>
    </section>
  );
}
