import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  evaluateSheetQuality,
  isRegistrationMetaLike,
  type RegistrationMetaLike,
  type SheetQualityVerdict,
} from '../src/lib/recognition/sheetQuality';
import { POST as qualityPOST } from '../src/app/api/uploads/quality/route';
import { POST as recognizePOST } from '../src/app/api/recognize/route';
import { resetUploadStoreForTests } from '../src/lib/storage/uploadStore';
import { createInventory, createTestBatch, uploadTestPage } from './helpers/uploadApi';
import { createJobSession, deleteJobWorkspace } from '../src/lib/storage/jobStore';
import { getJobDir } from '../src/lib/excel/templateManager';

const assetDir = path.join(process.cwd(), 'src', 'lib', 'recognition', 'assets');
const cagiBlankPath = path.join(assetDir, 'cagi-blank.png');
const satisfactionBlankPath = path.join(assetDir, 'satisfaction-blank.png');

// Spec F2.2 wording, asserted verbatim: F2's retake UI and F3's hints must
// never disagree in wording, so a reword in either place fails here.
const SPEC_HINTS = {
  paperNotFound: '종이가 배경과 구분되도록 어두운 바닥을 피해 다시 찍어주세요',
  cropped: '종이의 네 모서리가 모두 화면 안에 들어오게 찍어주세요',
  tooSmall: '종이가 화면을 더 채우도록 가까이서 찍어주세요',
  wrongShape: '종이 정면에서, 세로 방향으로 찍어주세요',
  unverified: '촬영 상태가 좋지 않아 인식 정확도가 낮을 수 있습니다. 다시 찍는 것을 권장합니다',
} as const;

function makeRegistration(overrides: Partial<RegistrationMetaLike> = {}): RegistrationMetaLike {
  return {
    method: 'quad',
    confidence: 0.9,
    orbInliers: 200,
    orbInlierRatio: 0.8,
    quadResidualPx: 6,
    rejection: null,
    verified: true,
    ...overrides,
  };
}

describe('sheet quality evaluator', () => {
  // The blanks are loaded once; the verdict tests below reinterpret the same
  // measurement under different registration meta without reloading.
  let cagiBlank: SheetQualityVerdict;
  let satisfactionBlank: SheetQualityVerdict;

  beforeAll(async () => {
    cagiBlank = await evaluateSheetQuality({ imagePath: cagiBlankPath, formType: 'cagi' });
    satisfactionBlank = await evaluateSheetQuality({
      imagePath: satisfactionBlankPath,
      formType: 'satisfaction',
    });
  }, 240000);

  it('populates every signal field for both form types', () => {
    for (const verdict of [cagiBlank, satisfactionBlank]) {
      expect(verdict.signals.width).toBeGreaterThan(0);
      expect(verdict.signals.height).toBeGreaterThan(0);
      expect(verdict.signals.pageInkRatio).toBeGreaterThan(0);
      expect(verdict.signals.pageInkRatio).toBeLessThan(1);
      expect(typeof verdict.signals.pageIsBinarySource).toBe('boolean');
      expect(typeof verdict.signals.contentBoundsSource).toBe('string');
      expect(verdict.signals.contentBoundsSource.length).toBeGreaterThan(0);
      expect(typeof verdict.signals.contentBoundsConfident).toBe('boolean');
      expect(verdict.signals.registration).toBeNull();
      expect(Array.isArray(verdict.reasons)).toBe(true);
      expect(Array.isArray(verdict.hints)).toBe(true);
    }
  });

  it('detects a healthy grid on the clean blank scans', () => {
    // The blanks are clean scans; the grid detector should recover most of
    // the response tables. This pins the measurement plumbing, not a verdict
    // band — gridFields is reported only (T3 2026-08-27).
    expect(cagiBlank.signals.gridFields).toBeGreaterThanOrEqual(10);
    expect(satisfactionBlank.signals.gridFields).toBeGreaterThanOrEqual(10);
  });

  it('reads a sheet without registration meta as good (scan path must never be told to retake)', () => {
    for (const verdict of [cagiBlank, satisfactionBlank]) {
      expect(verdict.verdict).toBe('good');
      expect(verdict.reasons).toEqual(['no-registration-meta']);
      expect(verdict.hints).toEqual([]);
    }
  });

  it('reads verified registration as good with no hint', async () => {
    const verdict = await evaluateSheetQuality({
      imagePath: satisfactionBlankPath,
      formType: 'satisfaction',
      registration: makeRegistration(),
    });

    expect(verdict.verdict).toBe('good');
    expect(verdict.reasons).toEqual(['registration-verified']);
    expect(verdict.hints).toEqual([]);
    expect(verdict.signals.registration?.method).toBe('quad');
  }, 120000);

  it("reads method 'none' as unusable with the rejection-specific spec hint", async () => {
    const verdict = await evaluateSheetQuality({
      imagePath: cagiBlankPath,
      formType: 'cagi',
      registration: makeRegistration({
        method: 'none',
        confidence: 0,
        verified: false,
        rejection: 'cropped',
      }),
    });

    expect(verdict.verdict).toBe('unusable');
    expect(verdict.reasons).toEqual(['registration-none']);
    expect(verdict.hints).toEqual([SPEC_HINTS.cropped]);
  }, 120000);

  it("maps a null rejection on method 'none' to the paper-not-found hint", async () => {
    const verdict = await evaluateSheetQuality({
      imagePath: cagiBlankPath,
      formType: 'cagi',
      registration: makeRegistration({
        method: 'none',
        confidence: 0,
        verified: false,
        rejection: null,
      }),
    });

    expect(verdict.verdict).toBe('unusable');
    expect(verdict.hints).toEqual([SPEC_HINTS.paperNotFound]);
  }, 120000);

  it('reads an unverified warp as retake-suggested with the spec wording', async () => {
    const verdict = await evaluateSheetQuality({
      imagePath: cagiBlankPath,
      formType: 'cagi',
      registration: makeRegistration({ method: 'orb', verified: false }),
    });

    expect(verdict.verdict).toBe('retake-suggested');
    expect(verdict.reasons).toEqual(['unverified-warp']);
    expect(verdict.hints).toEqual([SPEC_HINTS.unverified]);
  }, 120000);

  it("keeps the remaining spec F2.2 hint wording reachable through 'none' rejections", async () => {
    const expectations = [
      { rejection: 'too-small', hint: SPEC_HINTS.tooSmall },
      { rejection: 'wrong-shape', hint: SPEC_HINTS.wrongShape },
    ] as const;

    for (const { rejection, hint } of expectations) {
      const verdict = await evaluateSheetQuality({
        imagePath: satisfactionBlankPath,
        formType: 'satisfaction',
        registration: makeRegistration({
          method: 'none',
          confidence: 0,
          verified: false,
          rejection,
        }),
      });
      expect(verdict.hints).toEqual([hint]);
    }
  }, 240000);

  it('validates registration meta structurally', () => {
    expect(isRegistrationMetaLike(makeRegistration())).toBe(true);
    expect(isRegistrationMetaLike(null)).toBe(false);
    expect(isRegistrationMetaLike({})).toBe(false);
    expect(isRegistrationMetaLike(makeRegistration({ method: 'magic' as never }))).toBe(false);
    expect(isRegistrationMetaLike({ ...makeRegistration(), verified: 'yes' as never })).toBe(false);
    expect(isRegistrationMetaLike({ ...makeRegistration(), quadResidualPx: 'far' as never })).toBe(false);
  });
});

describe('POST /api/uploads/quality', () => {
  const jobId = 'job_1234';
  const imageId = 'sheetquality0001';

  beforeAll(() => {
    createJobSession(jobId);
    const uploadDir = path.join(getJobDir(jobId), 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.copyFileSync(cagiBlankPath, path.join(uploadDir, `${imageId}.png`));
  });

  afterAll(() => {
    deleteJobWorkspace(jobId);
  });

  function callQuality(body: unknown) {
    return qualityPOST(new Request('http://localhost/api/uploads/quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as any);
  }

  it('returns a verdict for a stored upload', async () => {
    const response = await callQuality({ jobId, type: 'cagi', imageId });
    expect(response.status).toBe(200);

    const verdict = await response.json() as SheetQualityVerdict;
    expect(verdict.verdict).toBe('good');
    expect(verdict.reasons).toEqual(['no-registration-meta']);
    expect(verdict.signals.gridFields).toBeGreaterThanOrEqual(10);
  }, 120000);

  it('interprets client registration meta through the same evaluator', async () => {
    const response = await callQuality({
      jobId,
      type: 'cagi',
      imageId,
      registration: makeRegistration({
        method: 'none',
        confidence: 0,
        verified: false,
        rejection: 'cropped',
      }),
    });
    expect(response.status).toBe(200);

    const verdict = await response.json() as SheetQualityVerdict;
    expect(verdict.verdict).toBe('unusable');
    expect(verdict.hints).toEqual([SPEC_HINTS.cropped]);
  }, 120000);

  it('rejects an invalid job id before touching storage', async () => {
    const response = await callQuality({ jobId: '../etc', type: 'cagi', imageId });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid upload type', async () => {
    const response = await callQuality({ jobId, type: 'unknown', imageId });
    expect(response.status).toBe(400);
  });

  it('rejects a traversal-shaped image id', async () => {
    const response = await callQuality({ jobId, type: 'cagi', imageId: '../secret' });
    expect(response.status).toBe(400);
  });

  it('rejects malformed registration meta', async () => {
    const response = await callQuality({
      jobId,
      type: 'cagi',
      imageId,
      registration: { method: 'quad' },
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a job without a session', async () => {
    const response = await callQuality({ jobId: 'job_9999', type: 'cagi', imageId });
    expect(response.status).toBe(404);
  });

  it('returns 404 for an image that does not exist', async () => {
    const response = await callQuality({ jobId, type: 'cagi', imageId: 'missing0001' });
    expect(response.status).toBe(404);
  });
});

describe('recognize route sheet-quality attachment', () => {
  afterEach(() => {
    resetUploadStoreForTests();
  });

  it('attaches the same evaluator verdicts to each student draft', async () => {
    const jobId = 'job_sheet_quality_recognize';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();

    expect((await uploadTestPage(jobId, 'cagi', cagi, 1, fs.readFileSync(cagiBlankPath))).status).toBe(200);
    expect((await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, fs.readFileSync(satisfactionBlankPath))).status).toBe(200);

    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction) }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.studentDrafts).toHaveLength(1);

    // The server-side recognize path has no F1 registration meta, so both
    // sheets read as provenance-unknown 'good' — a scan is never told to
    // retake — while the measurements travel in signals.
    const sheetQuality = body.studentDrafts[0].sheetQuality;
    expect(sheetQuality).toBeTruthy();
    for (const verdict of [sheetQuality.cagi, sheetQuality.satisfaction] as SheetQualityVerdict[]) {
      expect(verdict.verdict).toBe('good');
      expect(verdict.reasons).toEqual(['no-registration-meta']);
      expect(verdict.signals.gridFields).toBeGreaterThanOrEqual(10);
      expect(verdict.signals.registration).toBeNull();
    }
  }, 240000);
});
