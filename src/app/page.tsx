'use client';

import React, { useState } from 'react';
import ImageUploadPanel, { UploadMode } from '@/components/ImageUploadPanel';
import RecognitionReview from '@/components/RecognitionReview';
import StudentTable from '@/components/StudentTable';
import ErrorSummary from '@/components/ErrorSummary';
import { RecognitionDraft } from '@/lib/recognition/detectCheckmarks';
import { StudentData, ValidationError } from '@/lib/validation/types';

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
    <div className="brand-header">
      <div className="brand-lockup" aria-label="한국도박문제예방치유원">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <div className="brand-title">한국도박문제예방치유원</div>
          <div className="brand-subtitle">Korea Problem Gambling Agency</div>
        </div>
      </div>
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

  const [isRecognizing, setIsRecognizing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [notices, setNotices] = useState<string[]>([]);

  const resetDraft = () => {
    setCagiImageId(null);
    setSatImageId(null);
    setDrafts(null);
    setCurrentDraftIndex(0);
    setErrors([]);
    setNotices([]);
  };

  const handleStartNewJob = async (selectedMode: UploadMode) => {
    try {
      const res = await fetch('/api/jobs', { method: 'POST' });
      if (!res.ok) throw new Error('서버 응답 오류');
      const data = await res.json();
      setJobId(data.jobId);
      setUploadMode(selectedMode);
      setStudents([]);
      resetDraft();
      setErrors([]);
      setNotices([]);
    } catch (err: any) {
      alert(`새 작업을 시작할 수 없습니다: ${err.message}`);
    }
  };

  const handleSequentialUploadSuccess = async (type: 'cagi' | 'satisfaction', imageId: string) => {
    let currentCagi = cagiImageId;
    let currentSat = satImageId;

    if (type === 'cagi') {
      setCagiImageId(imageId);
      currentCagi = imageId;
    } else {
      setSatImageId(imageId);
      currentSat = imageId;
    }

    if (currentCagi && currentSat && jobId) {
      setIsRecognizing(true);
      setErrors([]);
      setNotices([]);
      try {
        const res = await fetch('/api/recognize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        });

        const data = await res.json();

        if (!res.ok) {
          setErrors([{ code: data.code || 'RECOGNIZE_ERROR', message: data.error }]);
          return;
        }

        setDrafts(data.studentDrafts);
        setNotices(data.warnings || []);
        setCurrentDraftIndex(0);
      } catch (err: any) {
        setErrors([{ code: 'API_ERROR', message: `이미지 인식 요청 오류: ${err.message}` }]);
      } finally {
        setIsRecognizing(false);
      }
    }
  };

  const handleTriggerBatchAnalysis = async () => {
    if (!jobId) return;

    setIsRecognizing(true);
    setErrors([]);
    setNotices([]);
    try {
      const res = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrors([{ code: data.code || 'RECOGNIZE_ERROR', message: data.error }]);
        return;
      }

      setDrafts(data.studentDrafts);
      setNotices(data.warnings || []);
      setCurrentDraftIndex(0);
    } catch (err: any) {
      setErrors([{ code: 'API_ERROR', message: `일괄 이미지 분석 오류: ${err.message}` }]);
    } finally {
      setIsRecognizing(false);
    }
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

    setIsSaving(true);
    setErrors([]);

    try {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          student: currentDraft,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.errors) {
          setErrors(data.errors);
        } else {
          setErrors([{ code: 'SAVE_FAILED', message: data.error }]);
        }
        return;
      }

      setStudents([...students, data.student]);

      const nextIndex = currentDraftIndex + 1;
      if (nextIndex < drafts.length) {
        setCurrentDraftIndex(nextIndex);
        setErrors([]);
        setNotices([]);
      } else {
        resetDraft();
      }
    } catch (err: any) {
      setErrors([{ code: 'SAVE_EXCEPTION', message: `학생 저장 처리 중 실패: ${err.message}` }]);
    } finally {
      setIsSaving(false);
    }
  };

  const hasDrafts = Boolean(drafts && drafts.length > 0);
  const modeLabel = uploadMode === 'sequential' ? '개별/순차 촬영' : '일괄 스캔 업로드';
  const downloadHref = (type: 'cagi' | 'satisfaction') => (jobId ? `/api/download?jobId=${jobId}&type=${type}` : '#');
  const blockEmptyDownload = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!jobId || students.length === 0) {
      e.preventDefault();
      alert('저장된 학생 데이터가 없습니다.');
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

      {!jobId ? (
        <UploadModeSelector onStart={handleStartNewJob} />
      ) : (
        <div className="work-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <ErrorSummary errors={errors} />
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
                </div>
              </div>
            )}

            {hasDrafts && drafts && (
              <RecognitionReview
                draft={drafts[currentDraftIndex]}
                jobId={jobId}
                onChange={handleDraftChange}
                onSave={handleSaveStudent}
                onReset={resetDraft}
                isSaving={isSaving}
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
                <a
                  href={downloadHref('cagi')}
                  className={`download-card ${students.length === 0 ? 'disabled' : ''}`}
                  onClick={blockEmptyDownload}
                >
                  <span className="form-label sky">FORM 01</span>
                  <strong>양식_청소년도박문제선별검사_CAGI_3.xlsx</strong>
                  <span>선별검사 데이터(A~M열) 작성본</span>
                  <em>다운로드</em>
                </a>
                <a
                  href={downloadHref('satisfaction')}
                  className={`download-card ${students.length === 0 ? 'disabled' : ''}`}
                  onClick={blockEmptyDownload}
                >
                  <span className="form-label orange">FORM 02</span>
                  <strong>청소년예방교육만족도.xlsx</strong>
                  <span>예방만족도 설문 데이터(A~N열) 작성본</span>
                  <em>다운로드</em>
                </a>
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
