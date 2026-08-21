import React from 'react';
import { RecognitionDraft, type RecognitionValueSource } from '../lib/recognition/detectCheckmarks';
import { ValidationError } from '../lib/validation/types';

interface RecognitionReviewProps {
  draft: RecognitionDraft;
  jobId: string;
  onChange: (updatedDraft: RecognitionDraft) => void;
  onSave: () => void;
  onReset: () => void;
  isSaving: boolean;
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

const cropSourceLabel = {
  grid: '격자 검증 완료',
  'grid-candidate': '격자 후보',
  row: '행 검출',
  'row-fallback': '격자 후보 -> 행 폴백',
  fixed: '위치 특정 실패 (구역 전체 표시)',
};

export default function RecognitionReview({
  draft,
  jobId,
  onChange,
  onSave,
  onReset,
  isSaving,
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

  const buildManualReviewSource = (field: string) => {
    const priorTrace = draft.source?.recognitionDecisionTrace?.[field];

    return {
      ...(draft.source || {}),
      recognitionValueSource: {
        ...(draft.source?.recognitionValueSource || {}),
        [field]: 'manual' as RecognitionValueSource,
      },
      recognitionManualEditedAt: {
        ...(draft.source?.recognitionManualEditedAt || {}),
        [field]: new Date().toISOString(),
      },
      recognitionDecisionTrace: {
        ...(draft.source?.recognitionDecisionTrace || {}),
        [field]: priorTrace
          ? `${priorTrace} Value was entered or changed during manual review.`
          : 'Value was entered or changed during manual review.',
      },
    };
  };

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
  const isSettled = (key: string) => draft.source?.recognitionValueSource?.[key] === 'manual';

  const fieldDomId = (key: string) => `review-field-${key.replace(/\./g, '-')}`;

  const focusField = (key: string) => {
    if (typeof document === 'undefined') return;
    const card = document.getElementById(fieldDomId(key));
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Focus the control rather than the card, so the reviewer can answer with
    // the keyboard the moment they arrive.
    const control = card.querySelector<HTMLElement>('select, input');
    control?.focus({ preventScroll: true });
  };

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
    // Including when there is no value: a student who answered nothing is a
    // fact about the form, and the reviewer needs a way to record having seen
    // it. The handlers write the value back as it stands and mark the field
    // reviewed, so an empty one stays empty and stops being outstanding.
    if (group === 'basic') handleBasicChange(name, value);
    else if (group === 'cagi') handleCagiChange(name, value as number);
    else handleSatisfactionChange(name, value as number);
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
   * The attention field's one-click disposal.
   *
   * Shown only where there is a value to accept: a blank field needs an answer,
   * and picking one already marks it settled through the normal change path.
   */
  const renderConfirmButton = (key: string) => {
    if (confidenceRank[getConfidenceLevel(key)] === 0) return null;
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

  const renderCropSourceBadge = (key: string) => {
    const source = draft.source?.recognitionCropSource?.[key];
    if (!source) return null;
    const diagnostic = showDiagnostics ? draft.source?.recognitionCropDiagnostic?.[key] : undefined;
    const registration = draft.source?.recognitionRegistration?.[key];
    const registrationLabel = registration?.status === 'verified'
      ? '좌표 검증'
      : registration?.status === 'candidate'
        ? '좌표 후보'
        : registration?.status === 'failed'
          ? '좌표 실패'
          : undefined;

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
          {cropSourceLabel[source]}
        </span>
        {registrationLabel && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 22,
              padding: '2px 7px',
              borderRadius: 999,
              border: registration?.status === 'verified' ? '1px solid #9fdfc5' : '1px solid #f3c38f',
              color: registration?.status === 'verified' ? '#177245' : '#9a5a11',
              background: registration?.status === 'verified' ? '#eefaf3' : '#fff8e7',
              fontSize: 11,
              fontWeight: 800,
              whiteSpace: 'nowrap',
            }}
            title={registration?.tableId}
          >
            {registrationLabel}
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

  const renderValueSourceBadge = (key: string) => {
    const source = draft.source?.recognitionValueSource?.[key] || 'unresolved';
    const manualEditedAt = draft.source?.recognitionManualEditedAt?.[key];
    const styleMap: Record<RecognitionValueSource, { border: string; text: string; bg: string; label: string }> = {
      auto: { border: '#9fdfc5', text: '#177245', bg: '#eefaf3', label: '자동 인식' },
      manual: { border: '#b9c8f3', text: '#405aa8', bg: '#f2f5ff', label: '수기 수정' },
      unresolved: { border: '#d8dde8', text: '#667085', bg: '#f6f8fb', label: '미확정' },
    };
    const style = styleMap[source];
    const title = manualEditedAt
      ? `수기 수정 시각: ${new Date(manualEditedAt).toLocaleString('ko-KR')}`
      : source === 'auto'
        ? '자동 인식값으로 확정되었습니다.'
        : '자동 인식값이 확정되지 않아 검수가 필요합니다.';

    return (
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
    if (!inlineUrl) return null;

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 5 }}>
          {renderCropSourceBadge(key)}
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
    (key) => confidenceRank[getConfidenceLevel(key)] > 0 || needsValue(key),
  );
  // What is still outstanding, in the order the fields appear on the page, so
  // "next" always moves down the screen and never jumps backwards.
  const pendingFields = attentionFields.filter((key) => !isSettled(key));
  const settledCount = attentionFields.length - pendingFields.length;
  const lowCount = pendingFields.filter((key) => getConfidenceLevel(key) === 'low').length;
  const mediumCount = pendingFields.filter((key) => getConfidenceLevel(key) === 'medium').length;
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
                  {' '}| {valueSource === 'auto' ? '자동 인식' : valueSource === 'manual' ? '수기 수정' : '미확정'}
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
      {renderFieldCropPreview(badgeKey)}
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
      </div>

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
              <span>
                낮은 신뢰도 {lowCount}개, 확인 권장 {mediumCount}개입니다. 아래에서 항목을 눌러 바로 이동할 수 있습니다.
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
                {pendingFields.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => focusField(key)}
                    title={`${fieldLabel(key)}(으)로 이동`}
                    style={{
                      padding: '4px 10px',
                      fontSize: 12,
                      fontWeight: 700,
                      borderRadius: 999,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      border: `1px solid ${getConfidenceLevel(key) === 'low' ? '#f0b7b2' : '#f5d29a'}`,
                      color: getConfidenceLevel(key) === 'low' ? 'var(--error)' : 'var(--warning)',
                      background: getConfidenceLevel(key) === 'low' ? 'var(--error-bg)' : 'var(--warning-bg)',
                    }}
                  >
                    {fieldLabel(key)}
                  </button>
                ))}
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
                {renderFieldCropPreview(`cagi.q${num}`)}
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
            {renderFieldCropPreview('satisfaction.q01')}
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
                {renderFieldCropPreview(`satisfaction.q0${num}`)}
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
                {renderFieldCropPreview(`satisfaction.${key}`)}
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

      <button className="btn-primary" style={{ width: '100%' }} disabled={isSaving} onClick={onSave}>
        {isSaving ? '엑셀 반영 및 검증 중' : '검수 완료 및 엑셀 반영'}
      </button>
    </section>
  );
}
