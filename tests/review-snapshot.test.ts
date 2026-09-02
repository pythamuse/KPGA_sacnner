import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  REVIEW_SNAPSHOT_VERSION,
  buildReviewSnapshot,
  describeSnapshot,
  isRestorableSnapshot,
  stripDraftImages,
} from '../src/lib/session/reviewSnapshot';
import RecognitionReview, { suggestionOptionLabels } from '../src/components/RecognitionReview';
import {
  buildSheetQualityBadges,
  type SheetQualityAttachment,
  type SheetQualityVerdictLike,
} from '../src/lib/recognition/sheetQualityDisplay';
import type { RecognitionDraft } from '../src/lib/recognition/detectCheckmarks';
import type { DecisionEvidence } from '../src/lib/recognition/markDensity';
// Type-only: `sheetQuality.ts` reaches sharp through markDensity, and this
// import is erased at compile time. It exists so that `tsc --noEmit` fails the
// moment the server verdict and the client-side structural copy drift apart.
import type { SheetQualityVerdict } from '../src/lib/recognition/sheetQuality';
import type { StudentData } from '../src/lib/validation/types';

function makeDraft(): RecognitionDraft {
  return {
    basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
    cagi: { q01: 0, q02: 0 },
    satisfaction: { q01: 4, q02: 1 },
    confidence: { 'basic.gender': 'high', 'cagi.q01': 'high' },
    candidates: { 'basic.gender': [{ value: '여', score: 0.05 }] },
    source: {
      cagiImageId: 'cagi_page_001',
      satisfactionImageId: 'satisfaction_page_001',
      cagiImageDataUrl: 'data:image/jpeg;base64,AAAA',
      satisfactionImageDataUrl: 'data:image/jpeg;base64,BBBB',
      cropDataUrls: { 'basic.gender': 'data:image/png;base64,CCCC' },
      cropDebugDataUrls: { 'basic.gender': 'data:image/png;base64,DDDD' },
      recognitionCropSource: { 'basic.gender': 'grid' },
      recognitionCropDiagnostic: { 'basic.gender': 'grid candidate: gap rows 2%' },
      recognitionDecisionTrace: { 'basic.gender': 'Gender: automatic entry completed.' },
    },
  } as unknown as RecognitionDraft;
}

/**
 * Structural compatibility check, enforced by `tsc --noEmit` rather than at
 * runtime: whatever the server evaluator returns must still be something the
 * review strip can read. If `SheetQualityVerdict` grows a required field or
 * narrows one, this assignment stops compiling.
 */
const _verdictShapesStayCompatible: SheetQualityVerdictLike = {} as SheetQualityVerdict;
void _verdictShapesStayCompatible;

function makeVerdict(overrides: Partial<SheetQualityVerdictLike> = {}): SheetQualityVerdictLike {
  return {
    verdict: 'good',
    reasons: ['registration-verified'],
    hints: [],
    signals: {
      registration: {
        method: 'quad',
        confidence: 0.9,
        orbInliers: 200,
        orbInlierRatio: 0.8,
        quadResidualPx: 6,
        rejection: null,
        verified: true,
      },
    },
    ...overrides,
  } as SheetQualityVerdictLike;
}

function renderReview(draft: RecognitionDraft): string {
  return renderToStaticMarkup(
    React.createElement(RecognitionReview, {
      draft,
      jobId: 'job-1',
      onChange: () => undefined,
      onSave: () => undefined,
      onReset: () => undefined,
      isSaving: false,
    }),
  );
}

/**
 * Renders with the images stripped, which is both the resumed-session draft
 * and the only way '선별검사지' in the markup can only have come from the
 * verdict strip -- the original-image preview uses the same two words.
 */
function renderWithQuality(sheetQuality?: SheetQualityAttachment): string {
  const draft = stripDraftImages(makeDraft());
  if (sheetQuality) draft.sheetQuality = sheetQuality;
  return renderReview(draft);
}

/**
 * Just the verdict strip. The surrounding screen has its own amber notice for
 * pending fields and its own '선별검사지' in the image preview, so assertions
 * on the whole document would pass on the wrong element.
 */
function extractStrip(html: string): string {
  const marker = html.indexOf('role="status"');
  if (marker < 0) return '';
  const start = html.lastIndexOf('<div', marker);
  return html.slice(start, html.indexOf('</div></div>', start) + 12);
}

const student: StudentData = {
  studentIndex: 1,
  source: { cagiImageId: 'cagi_page_001', satisfactionImageId: 'satisfaction_page_001' },
  basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
  cagi: { q01: 0 } as StudentData['cagi'],
  satisfaction: { q01: 4 } as StudentData['satisfaction'],
  status: 'saved',
};

describe('review snapshot', () => {
  it('drops every rendered image but keeps the values a reviewer needs', () => {
    const slim = stripDraftImages(makeDraft());
    const source = slim.source as Record<string, unknown>;

    expect(source.cagiImageDataUrl).toBeUndefined();
    expect(source.satisfactionImageDataUrl).toBeUndefined();
    expect(source.cropDataUrls).toBeUndefined();
    expect(source.cropDebugDataUrls).toBeUndefined();

    expect(slim.basic).toEqual({ age: 14, gender: '여', schoolType: '중학교', grade: '2학년' });
    expect(slim.confidence).toEqual({ 'basic.gender': 'high', 'cagi.q01': 'high' });
    expect(source.recognitionCropSource).toEqual({ 'basic.gender': 'grid' });
    expect(source.recognitionDecisionTrace).toBeDefined();
    expect(source.cagiImageId).toBe('cagi_page_001');
  });

  it('keeps compact recognition evidence in the snapshot and renders it by default', () => {
    const draft = stripDraftImages(makeDraft());
    const evidence: DecisionEvidence = {
      outcome: 'refused',
      winner: { index: 0, score: 0.015 },
      gap: 0.002,
      thresholds: { score: 0.021, gap: 0.004, contrast: 1.25 },
      refused: ['absolute-floor', 'gap'],
      contested: false,
    };
    draft.source = {
      ...(draft.source || {}),
      recognitionEvidence: { 'cagi.q01': evidence },
    };

    const resumed = stripDraftImages(draft);
    expect(resumed.source?.recognitionEvidence?.['cagi.q01']).toEqual(evidence);

    const start = renderReview(resumed).indexOf('id="review-field-cagi-q01"');
    const html = renderReview(resumed);
    const card = html.slice(start, html.indexOf('id="review-field-', start + 10));
    expect(card).toContain('보류 — 잉크가 옅음(0.015 &lt; 0.021)');
    expect(card).toContain('흐림');
  });

  it('never writes scanned responses into browser storage', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student],
      drafts: [makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    // The whole point of storing values only: a batch of drafts with images is
    // ~1.6MB per student and would both blow the storage quota and keep student
    // responses in the browser (Docs/00_PRD.md §10, §10-2).
    expect(JSON.stringify(snapshot)).not.toContain('data:image');
  });

  it('keeps enough to resume: job, mode, saved students, and position', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student],
      drafts: [makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    expect(snapshot.version).toBe(REVIEW_SNAPSHOT_VERSION);
    expect(snapshot.jobId).toBe('job-1');
    expect(snapshot.uploadMode).toBe('batch');
    expect(snapshot.students).toHaveLength(1);
    expect(snapshot.drafts).toHaveLength(2);
    expect(snapshot.currentDraftIndex).toBe(1);
    expect(isRestorableSnapshot(snapshot)).toBe(true);
  });

  it('keeps field-level value sources for both saved rows and drafts', () => {
    const draft = makeDraft();
    draft.source = {
      ...(draft.source || {}),
      recognitionValueSource: {
        'basic.gender': 'confirmed',
        'cagi.q01': 'auto',
      },
    };
    const saved: StudentData = {
      ...student,
      source: {
        ...student.source,
        recognitionValueSource: { 'basic.gender': 'manual' },
      },
    };

    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [saved],
      drafts: [draft],
      currentDraftIndex: 0,
    });

    expect(snapshot.students[0].source.recognitionValueSource).toEqual({ 'basic.gender': 'manual' });
    expect(snapshot.drafts[0].source?.recognitionValueSource).toEqual({
      'basic.gender': 'confirmed',
      'cagi.q01': 'auto',
    });
  });

  it('refuses to offer a resume that carries no work', () => {
    const empty = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'sequential',
      students: [],
      drafts: null,
      currentDraftIndex: 0,
    });

    expect(isRestorableSnapshot(empty)).toBe(false);
    expect(isRestorableSnapshot(null)).toBe(false);
    expect(isRestorableSnapshot({ ...empty, version: 999, students: [student] })).toBe(false);
  });

  it('describes the recovery point so the user can tell which batch it is', () => {
    const snapshot = buildReviewSnapshot({
      jobId: 'job-1',
      uploadMode: 'batch',
      students: [student, student],
      drafts: [makeDraft(), makeDraft(), makeDraft()],
      currentDraftIndex: 1,
    });

    expect(describeSnapshot(snapshot)).toBe('저장 완료 2명 · 검수 대기 3명 중 2번째');
  });
});

describe('contested runner-up badge', () => {
  it('renders the warning beside an automatic value', () => {
    const draft = stripDraftImages(makeDraft());
    draft.source = {
      ...(draft.source || {}),
      recognitionValueSource: { 'basic.gender': 'auto' },
      recognitionContested: { 'basic.gender': true },
    };

    const html = renderReview(draft);

    expect(html).toContain('자동 인식');
    expect(html).toContain('경합');
    expect(html).toContain('다른 칸에도 표시 흔적이 있습니다 — 지운 표시인지 확인해주세요');
  });

  it('does not render the warning when the field is not contested', () => {
    const draft = stripDraftImages(makeDraft());
    draft.source = {
      ...(draft.source || {}),
      recognitionValueSource: { 'basic.gender': 'auto' },
      recognitionContested: { 'basic.gender': false },
    };

    expect(renderReview(draft)).not.toContain('경합');
  });
});

describe('machine-value settlement on the review screen', () => {
  it('keeps a restored value pending and disables saving until it is confirmed', () => {
    const draft = stripDraftImages(makeDraft());
    draft.source = {
      ...(draft.source || {}),
      recognitionValueSource: { 'basic.gender': 'restored' },
    };

    const html = renderReview(draft);

    expect(html).toContain('저장된 값이지만 확인이 필요합니다.');
    expect(html).toContain('확인되지 않은 자동 입력 1개 — 확인 후 저장할 수 있습니다');
    expect(html).toContain('이 값이 맞음');
    expect(html).toContain('disabled="">검수 완료 및 엑셀 반영</button>');
  });
});

describe('reviewer default on a refused field', () => {
  /** A draft whose `cagi.q03` was left blank, with or without a suggestion. */
  function makeBlankFieldDraft(suggested?: { candidateIndex: number; value: number | string }) {
    const draft = stripDraftImages(makeDraft());
    draft.cagi = { ...draft.cagi };
    delete draft.cagi.q03;
    draft.confidence = { ...draft.confidence, 'cagi.q03': 'low' };
    draft.source = {
      ...(draft.source || {}),
      ...(suggested ? { recognitionSuggestion: { 'cagi.q03': suggested } } : {}),
    };
    return draft;
  }

  it('marks the suggested option and says plainly that it is a guess', () => {
    const html = renderReview(makeBlankFieldDraft({ candidateIndex: 2, value: 2 }));

    expect(html).toContain('추천');
    expect(html).toContain('2 자주 있다');
    expect(html).toContain('이 칸일 가능성이 높습니다 — 확인해주세요');
  });

  it('leaves the control empty, so the reviewer still has to answer', () => {
    const html = renderReview(makeBlankFieldDraft({ candidateIndex: 2, value: 2 }));
    // Just this field's card: every other blank cell renders the same options.
    const start = html.indexOf('id="review-field-cagi-q03"');
    const card = html.slice(start, html.indexOf('id="review-field-', start + 10));

    expect(card).toContain('추천');
    // React marks the chosen option in static markup. The empty placeholder is
    // the selected one and no answer option is -- a suggestion is not a value.
    expect(card).toContain('<option value="" selected="">선택</option>');
    expect(card).not.toContain('selected="">2 자주 있다');
    expect(card).not.toContain('<option value="2" selected="">');
  });

  it('changes no count: the field is still outstanding', () => {
    const withSuggestion = renderReview(makeBlankFieldDraft({ candidateIndex: 2, value: 2 }));
    const without = renderReview(makeBlankFieldDraft());
    const count = (html: string) => html.match(/확인 필요 항목 (\d+)개/)?.[1];

    expect(count(withSuggestion)).toBe(count(without));
    expect(count(withSuggestion)).toBeDefined();
    // And the card still reports itself as unresolved, not as anything the
    // recognizer settled.
    expect(withSuggestion).toContain('미확정');
  });

  it('offers nothing once the field has an answer', () => {
    const draft = stripDraftImages(makeDraft());
    draft.source = {
      ...(draft.source || {}),
      recognitionSuggestion: { 'cagi.q01': { candidateIndex: 3, value: 3 } },
    };
    // `cagi.q01` is 0 in the fixture draft, so there is nothing to default.
    expect(renderReview(draft)).not.toContain('추천');
  });

  it('offers nothing once the reviewer has settled the field', () => {
    const draft = makeBlankFieldDraft({ candidateIndex: 2, value: 2 });
    draft.source = {
      ...(draft.source || {}),
      recognitionValueSource: { 'cagi.q03': 'blank_ok' },
    };

    expect(renderReview(draft)).not.toContain('추천');
  });

  it('renders nothing at all when no field carries a suggestion', () => {
    expect(renderReview(makeBlankFieldDraft())).not.toContain('추천');
  });

  it('names every option exactly as its select renders it', () => {
    // The suggestion strip keeps its own copy of the option labels. This is the
    // guard against that copy drifting away from the controls it describes.
    const html = renderReview(stripDraftImages(makeDraft()));
    const fields = [
      'basic.gender', 'basic.schoolType', 'basic.grade',
      'cagi.q01', 'cagi.q09',
      'satisfaction.q01', 'satisfaction.q02', 'satisfaction.q06',
      'satisfaction.q07', 'satisfaction.q10',
    ];
    for (const field of fields) {
      const labels = suggestionOptionLabels(field);
      expect(labels, field).toBeDefined();
      for (const [value, label] of Object.entries(labels!)) {
        // `selected=""` lands between the two on whichever option is current.
        const rendered = new RegExp(`value="${value}"( selected="")?>${label}</option>`);
        expect(rendered.test(html), `${field} = ${value} (${label})`).toBe(true);
      }
    }
  });
});

describe('multi-tab and image separation', () => {
  it('leaves a newer snapshot from another tab alone', async () => {
    const { isForeignerNewer } = await import('../src/lib/session/reviewSnapshot');
    const mine = { ...buildReviewSnapshot({
      jobId: 'job-1', uploadMode: 'batch', students: [student], drafts: null, currentDraftIndex: 0,
    }), writerId: 'tab-A', savedAt: 1000 };
    const otherNewer = { ...mine, writerId: 'tab-B', savedAt: 2000 };
    const otherOlder = { ...mine, writerId: 'tab-B', savedAt: 10 };
    const sameTab = { ...mine, savedAt: 2000 };

    expect(isForeignerNewer(otherNewer, mine)).toBe(true);
    expect(isForeignerNewer(otherOlder, mine)).toBe(false);
    expect(isForeignerNewer(sameTab, mine)).toBe(false);
    expect(isForeignerNewer(null, mine)).toBe(false);
  });

  it('carries the per-sheet verdicts through a resume', () => {
    const draft = makeDraft();
    draft.sheetQuality = { cagi: makeVerdict({ verdict: 'unusable' }) };

    const slim = stripDraftImages(draft);

    // The strip has to survive a refresh: a reviewer who resumes a batch needs
    // the same warning about the same sheet, and re-running recognition to get
    // it back is not on offer.
    expect(slim.sheetQuality?.cagi?.verdict).toBe('unusable');
    expect(JSON.stringify(slim)).not.toContain('data:image');
  });

  it('gives each job its own key so two batches cannot collide', async () => {
    const { snapshotKeyFor } = await import('../src/lib/session/reviewSnapshot');
    expect(snapshotKeyFor('job-1')).not.toBe(snapshotKeyFor('job-2'));
    expect(snapshotKeyFor('job-1')).toContain('job-1');
  });

  it('splits a draft into values for localStorage and images for the cache', async () => {
    const { extractDraftImages, mergeDraftImages } = await import('../src/lib/session/imageCache');
    const draft = makeDraft();
    const images = extractDraftImages(draft);
    const slim = stripDraftImages(draft);

    // Nothing is lost: what one side drops, the other keeps.
    expect(images.cagiImageDataUrl).toBe('data:image/jpeg;base64,AAAA');
    expect(images.cropDataUrls).toEqual({ 'basic.gender': 'data:image/png;base64,CCCC' });
    expect(JSON.stringify(slim)).not.toContain('data:image');

    const rebuilt = mergeDraftImages(slim, images);
    expect((rebuilt.source as Record<string, unknown>).cagiImageDataUrl).toBe('data:image/jpeg;base64,AAAA');
    expect(rebuilt.basic).toEqual(draft.basic);
  });
});

/**
 * The review screen's capture-verdict strip (spec F3, unit U-A).
 *
 * Asserted against the component's real rendered markup rather than a helper's
 * return value: the failure this guards against is a verdict that gets
 * computed and then never reaches the screen, and only rendering catches that.
 */
describe('sheet quality strip on the review screen', () => {
  it('shows a badge per side, in the same words the upload panel uses', () => {
    const strip = extractStrip(renderWithQuality({
      cagi: makeVerdict({ verdict: 'good' }),
      satisfaction: makeVerdict({ verdict: 'good' }),
    }));

    expect(strip).toContain('촬영 상태 판정');
    expect(strip).toContain('선별검사지');
    expect(strip).toContain('만족도조사');
    expect(strip.match(/정상/g)).toHaveLength(2);
  });

  it('renders each of the three verdicts, in the tone that verdict deserves', () => {
    const good = extractStrip(renderWithQuality({ cagi: makeVerdict({ verdict: 'good' }) }));
    expect(good).toContain('정상');
    // An all-clear must not sit in the amber box this screen uses for work
    // that is still outstanding -- that would say the opposite of what it means.
    expect(good).not.toContain('notice');
    expect(good).not.toContain('error-box');

    const retake = extractStrip(renderWithQuality({
      cagi: makeVerdict({
        verdict: 'retake-suggested',
        reasons: ['unverified-warp'],
        hints: ['촬영 상태가 좋지 않아 인식 정확도가 낮을 수 있습니다. 다시 찍는 것을 권장합니다'],
      }),
    }));
    expect(retake).toContain('재촬영 권장');
    expect(retake).toContain('class="notice"');

    const unusable = extractStrip(renderWithQuality({
      satisfaction: makeVerdict({
        verdict: 'unusable',
        reasons: ['registration-none'],
        hints: ['종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요'],
      }),
    }));
    expect(unusable).toContain('인식 불가 우려');
    expect(unusable).toContain('class="error-box"');
  });

  it('shows the first hint as muted text, and only the first', () => {
    const strip = extractStrip(renderWithQuality({
      cagi: makeVerdict({
        verdict: 'unusable',
        reasons: ['registration-none'],
        hints: ['종이가 화면을 더 채우도록 가까이서 찍어주세요', '두 번째 안내'],
      }),
    }));

    expect(strip).toContain('종이가 화면을 더 채우도록 가까이서 찍어주세요');
    expect(strip).toContain('var(--text-muted)');
    expect(strip).not.toContain('두 번째 안내');
  });

  it('marks a sheet the user insisted on uploading', () => {
    // Spec F2.3: the retake prompt carries a "use as-is" button, and the sheet
    // it lets through is exactly the one whose values a reviewer should not
    // take on trust. Without this marker it is indistinguishable on this
    // screen from a sheet the pipeline accepted.
    const html = renderWithQuality({
      cagi: makeVerdict({
        verdict: 'unusable',
        reasons: ['registration-none'],
        hints: ['종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요'],
        signals: { registration: { overridden: true } },
      }),
    });

    expect(html).toContain('인식 불가 우려 · 사용자 강행');
  });

  it('renders nothing at all when the draft carries no verdict', () => {
    const html = renderWithQuality();

    expect(html).not.toContain('촬영 상태 판정');
    expect(html).not.toContain('정상');
    expect(html).toContain('인식 결과 검수');
  });

  it('renders nothing for a scan, whose "good" was never a measurement', () => {
    // `/api/recognize` attaches a verdict to every student, and on the scan
    // path it is 'good' with reason no-registration-meta -- the evaluator
    // saying "no capture metadata reached me", not "this sheet passed".
    // Painting that as 정상 would be an absence dressed as a verdict.
    const unmeasured: SheetQualityVerdictLike = {
      verdict: 'good',
      reasons: ['no-registration-meta'],
      hints: [],
      signals: { registration: null },
    };
    const html = renderWithQuality({ cagi: unmeasured, satisfaction: unmeasured });

    expect(html).not.toContain('촬영 상태 판정');
    expect(html).toContain('인식 결과 검수');
  });
});

describe('sheet quality badges', () => {
  it('keeps the two sides in a fixed order and skips a missing one', () => {
    const badges = buildSheetQualityBadges({
      satisfaction: makeVerdict({ verdict: 'retake-suggested' }),
      cagi: makeVerdict({ verdict: 'unusable' }),
    });

    expect(badges.map((badge) => badge.side)).toEqual(['cagi', 'satisfaction']);
    expect(buildSheetQualityBadges({ cagi: makeVerdict() }).map((badge) => badge.side)).toEqual(['cagi']);
  });

  it('has nothing to say about an absent, empty, or unmeasured attachment', () => {
    expect(buildSheetQualityBadges(undefined)).toEqual([]);
    expect(buildSheetQualityBadges(null)).toEqual([]);
    expect(buildSheetQualityBadges({})).toEqual([]);
    expect(buildSheetQualityBadges({
      cagi: { verdict: 'good', reasons: ['no-registration-meta'], hints: [], signals: { registration: null } },
    })).toEqual([]);
  });

  it('appends the override marker only when the user actually forced it', () => {
    const forced = buildSheetQualityBadges({
      cagi: makeVerdict({ signals: { registration: { overridden: true } } }),
    });
    const normal = buildSheetQualityBadges({ cagi: makeVerdict() });

    expect(forced[0].overridden).toBe(true);
    expect(forced[0].label).toBe('정상 · 사용자 강행');
    expect(normal[0].overridden).toBe(false);
    expect(normal[0].label).toBe('정상');
  });
});
