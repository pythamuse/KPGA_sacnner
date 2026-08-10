import React from 'react';
import { RecognitionDraft } from '../lib/recognition/detectCheckmarks';

interface RecognitionReviewProps {
  draft: RecognitionDraft;
  jobId: string;
  onChange: (updatedDraft: RecognitionDraft) => void;
  onSave: () => void;
  onReset: () => void;
  isSaving: boolean;
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
  grid: '격자 검출',
  row: '행 검출',
  fixed: '위치 특정 실패 (구역 전체 표시)',
};

export default function RecognitionReview({
  draft,
  jobId,
  onChange,
  onSave,
  onReset,
  isSaving,
  currentIndex = 1,
  totalCount = 1,
}: RecognitionReviewProps) {
  const handleBasicChange = (field: string, val: any) => {
    onChange({
      ...draft,
      basic: {
        ...draft.basic,
        [field]: val,
      },
    });
  };

  const handleCagiChange = (field: string, val: number) => {
    onChange({
      ...draft,
      cagi: {
        ...draft.cagi,
        [field]: val,
      },
    });
  };

  const handleSatisfactionChange = (field: string, val: number) => {
    onChange({
      ...draft,
      satisfaction: {
        ...draft.satisfaction,
        [field]: val,
      },
    });
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

  const renderCropSourceBadge = (key: string) => {
    const source = draft.source?.recognitionCropSource?.[key];
    if (!source) return null;
    const diagnostic = source === 'fixed'
      ? draft.source?.recognitionCropDiagnostic?.[key]
      : undefined;

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
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
        {diagnostic && (
          <span style={{ color: '#6b7280', fontSize: 11, fontWeight: 600 }}>
            {diagnostic}
          </span>
        )}
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
    if (getConfidenceLevel(key) === 'high') return null;
    if (!draft.candidates?.[key]?.length && key !== 'basic.age') return null;

    const url = cropUrl(key);
    const debugUrl = cropUrl(key, true);
    const inlineUrl = debugUrl || url;
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
            href={debugUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => openDataUrlInNewTab(e, debugUrl)}
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
  const attentionFields = reviewKeys.filter((key) => confidenceRank[getConfidenceLevel(key)] > 0);
  const lowCount = attentionFields.filter((key) => getConfidenceLevel(key) === 'low').length;
  const mediumCount = attentionFields.filter((key) => getConfidenceLevel(key) === 'medium').length;

  const fieldShell = (label: string, badgeKey: string, control: React.ReactNode) => (
    <div style={getFieldCardStyle(badgeKey)}>
      <label style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 7 }}>
        {label}
        {renderConfidenceBadge(badgeKey)}
      </label>
      {control}
      {renderCandidateSummary(badgeKey)}
      {renderFieldCropPreview(badgeKey)}
    </div>
  );

  return (
    <section className="panel panel-pad animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 22, marginBottom: 6 }}>인식 결과 검수</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {currentIndex} / {totalCount}번째 학생 데이터입니다. 저장 전 값을 확인해주세요.
          </p>
        </div>
        <button className="btn-secondary" type="button" onClick={onReset}>
          검수 취소
        </button>
      </div>

      {attentionFields.length > 0 && (
        <div
          className={lowCount > 0 ? 'error-box' : 'notice'}
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <strong>확인 필요 항목 {attentionFields.length}개</strong>
          <span>
            낮은 신뢰도 {lowCount}개, 확인 권장 {mediumCount}개입니다. 강조된 항목의 원본 응답 표시를 보고 값을 확인해주세요.
          </span>
        </div>
      )}

      {draft.warnings?.map((warning) => (
        <div key={warning} className="notice" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>자동 인식 안내</strong>
          <span>{warning}</span>
        </div>
      ))}

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
              <div key={key} style={getFieldCardStyle(`cagi.q${num}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  CAGI {num}
                  {renderConfidenceBadge(`cagi.q${num}`)}
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
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 18, marginBottom: 14 }}>예방교육 만족도조사</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <div style={getFieldCardStyle('satisfaction.q01')}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
              문항1 교육 참여 횟수
              {renderConfidenceBadge('satisfaction.q01')}
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
          </div>

          {Array.from({ length: 5 }).map((_, idx) => {
            const num = idx + 2;
            const key = `q0${num}`;
            const val = draft.satisfaction[key];

            return (
              <div key={key} style={getFieldCardStyle(`satisfaction.q0${num}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  문항{num} 예/아니오
                  {renderConfidenceBadge(`satisfaction.q0${num}`)}
                </label>
                <select value={val !== undefined ? val : ''} onChange={(e) => handleSatisfactionChange(key, parseInt(e.target.value, 10))}>
                  <option value="">선택</option>
                  <option value="0">0 아니오</option>
                  <option value="1">1 예</option>
                </select>
                {renderCandidateSummary(`satisfaction.q0${num}`)}
                {renderFieldCropPreview(`satisfaction.q0${num}`)}
              </div>
            );
          })}

          {Array.from({ length: 4 }).map((_, idx) => {
            const num = idx + 7;
            const key = num === 10 ? 'q10' : `q0${num}`;
            const val = draft.satisfaction[key];

            return (
              <div key={key} style={getFieldCardStyle(`satisfaction.${key}`)}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 7 }}>
                  문항{num} 만족도
                  {renderConfidenceBadge(`satisfaction.${key}`)}
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
              </div>
            );
          })}
        </div>
      </div>

      <button className="btn-primary" style={{ width: '100%' }} disabled={isSaving} onClick={onSave}>
        {isSaving ? '엑셀 반영 및 검증 중' : '검수 완료 및 엑셀 반영'}
      </button>
    </section>
  );
}
