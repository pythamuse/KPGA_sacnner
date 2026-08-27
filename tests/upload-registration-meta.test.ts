import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { POST as recognizePOST } from '../src/app/api/recognize/route';
import {
  deleteJobUploads,
  readUploadPage,
  readUploadPageMeta,
  resetUploadStoreForTests,
} from '../src/lib/storage/uploadStore';
import {
  isRegistrationMetaLike,
  type RegistrationMetaLike,
  type SheetQualityVerdict,
} from '../src/lib/recognition/sheetQuality';
import { createInventory, createTestBatch, uploadTestPage } from './helpers/uploadApi';

/**
 * U-D: does the client's F1 capture meta survive the upload and come back at
 * recognize time, attached to the RIGHT physical sheet?
 *
 * Before this, `buildSheetQualityAttachment` hardcoded `registration: null`,
 * so the review screen's verdict strip could only ever say
 * `no-registration-meta` — a photographed sheet that the pipeline never
 * registered arrived looking exactly like a clean scan.
 */

const assetDir = path.join(process.cwd(), 'src', 'lib', 'recognition', 'assets');
const cagiBlankPath = path.join(assetDir, 'cagi-blank.png');
const satisfactionBlankPath = path.join(assetDir, 'satisfaction-blank.png');

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

const UNREGISTERED = makeRegistration({
  method: 'none',
  confidence: 0,
  orbInliers: 0,
  orbInlierRatio: 0,
  quadResidualPx: null,
  verified: false,
  rejection: 'cropped',
});

const UNVERIFIED = makeRegistration({ method: 'orb', confidence: 0, verified: false });

describe('upload route registration meta', () => {
  afterEach(() => {
    resetUploadStoreForTests();
  });

  it('stores the registration field alongside the page and reads it back', async () => {
    const jobId = 'job_meta_roundtrip';
    const batch = createTestBatch(1);
    const registration = makeRegistration({ overridden: true });

    const response = await uploadTestPage(
      jobId, 'cagi', batch, 1, 'page-bytes', 'cagi_page_001.png', 'image/png', registration,
    );
    expect(response.status).toBe(200);

    const stored = await readUploadPageMeta(jobId, 'cagi', batch, 1);
    expect(isRegistrationMetaLike(stored)).toBe(true);
    expect(stored).toEqual(registration);

    // The page bytes must be untouched by the sidecar living next to them.
    const page = await readUploadPage(jobId, 'cagi', batch, 1);
    expect(page?.data.toString('utf8')).toBe('page-bytes');
  });

  it('keys the meta by page, so pages in one batch do not share a verdict', async () => {
    const jobId = 'job_meta_per_page';
    const batch = createTestBatch(2);

    expect((await uploadTestPage(
      jobId, 'satisfaction', batch, 1, 'p1', 'satisfaction_page_001.png', 'image/png', UNVERIFIED,
    )).status).toBe(200);
    expect((await uploadTestPage(
      jobId, 'satisfaction', batch, 2, 'p2', 'satisfaction_page_002.png', 'image/png', UNREGISTERED,
    )).status).toBe(200);

    expect(await readUploadPageMeta(jobId, 'satisfaction', batch, 1)).toEqual(UNVERIFIED);
    expect(await readUploadPageMeta(jobId, 'satisfaction', batch, 2)).toEqual(UNREGISTERED);
  });

  it('reads null for a page uploaded without meta (scan and PDF batch path)', async () => {
    const jobId = 'job_meta_absent';
    const batch = createTestBatch(1);

    expect((await uploadTestPage(jobId, 'cagi', batch, 1, 'page-bytes')).status).toBe(200);
    expect(await readUploadPageMeta(jobId, 'cagi', batch, 1)).toBeNull();
  });

  it('reads null for a page that was never uploaded at all', async () => {
    expect(await readUploadPageMeta('job_meta_missing', 'cagi', createTestBatch(1), 1)).toBeNull();
  });

  it('stores nothing for malformed meta and still succeeds the upload', async () => {
    // Meta is best-effort: refusing the upload over a bad sidecar would lose
    // the page, which is the one thing that actually matters.
    const cases: Array<{ name: string; registration: unknown }> = [
      { name: 'not JSON at all', registration: 'not-json{' },
      { name: 'JSON but not an object', registration: '"quad"' },
      { name: 'empty string', registration: '' },
      { name: 'structurally incomplete', registration: { method: 'quad' } },
      { name: 'unknown method', registration: makeRegistration({ method: 'magic' as never }) },
      { name: 'wrong field type', registration: { ...makeRegistration(), verified: 'yes' } },
      { name: 'null', registration: 'null' },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index];
      const jobId = `job_meta_invalid_${index}`;
      const batch = createTestBatch(1);
      const response = await uploadTestPage(
        jobId, 'cagi', batch, 1, 'page-bytes',
        'cagi_page_001.png', 'image/png', testCase.registration,
      );

      expect(response.status, testCase.name).toBe(200);
      expect(await readUploadPageMeta(jobId, 'cagi', batch, 1), testCase.name).toBeNull();
      expect((await readUploadPage(jobId, 'cagi', batch, 1))?.data.toString('utf8')).toBe('page-bytes');
    }
  });

  it('sweeps the meta with the page under the same job prefix', async () => {
    // uploadStore.ts deleteJobUploads() deletes by the `<job>/uploads/` prefix,
    // and the meta pathname is the page pathname plus a suffix — so it is
    // inside that prefix by construction. Asserted rather than assumed:
    // student capture metadata must not outlive the job that produced it.
    const jobId = 'job_meta_cleanup';
    const batch = createTestBatch(1);

    expect((await uploadTestPage(
      jobId, 'cagi', batch, 1, 'page-bytes', 'cagi_page_001.png', 'image/png', UNREGISTERED,
    )).status).toBe(200);
    expect(await readUploadPageMeta(jobId, 'cagi', batch, 1)).toEqual(UNREGISTERED);

    await deleteJobUploads(jobId);

    expect(await readUploadPageMeta(jobId, 'cagi', batch, 1)).toBeNull();
    expect(await readUploadPage(jobId, 'cagi', batch, 1)).toBeNull();
  });
});

describe('recognize route reads stored registration meta', () => {
  afterEach(() => {
    resetUploadStoreForTests();
  });

  type Attachment = { cagi: SheetQualityVerdict; satisfaction: SheetQualityVerdict };

  async function recognize(jobId: string, cagi: ReturnType<typeof createTestBatch>,
    satisfaction: ReturnType<typeof createTestBatch>, satisfactionOrder: 'same' | 'reversed') {
    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction), satisfactionOrder }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.studentDrafts as Array<{ sheetQuality: Attachment }>;
  }

  it("attaches 'unusable' to a student whose upload carried method 'none' meta", async () => {
    const jobId = 'job_meta_recognize_unusable';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();

    expect((await uploadTestPage(
      jobId, 'cagi', cagi, 1, fs.readFileSync(cagiBlankPath),
      'cagi_page_001.png', 'image/png', UNREGISTERED,
    )).status).toBe(200);
    // Left without meta on purpose: the two sheets of one student are judged
    // separately, and a missing sidecar must still read as provenance-unknown.
    expect((await uploadTestPage(
      jobId, 'satisfaction', satisfaction, 1, fs.readFileSync(satisfactionBlankPath),
    )).status).toBe(200);

    const drafts = await recognize(jobId, cagi, satisfaction, 'same');
    expect(drafts).toHaveLength(1);

    const { cagi: cagiVerdict, satisfaction: satVerdict } = drafts[0].sheetQuality;
    expect(cagiVerdict.verdict).toBe('unusable');
    expect(cagiVerdict.reasons).toEqual(['registration-none']);
    expect(cagiVerdict.signals.registration).toEqual(UNREGISTERED);

    expect(satVerdict.verdict).toBe('good');
    expect(satVerdict.reasons).toEqual(['no-registration-meta']);
    expect(satVerdict.signals.registration).toBeNull();

    // Recognize deletes the batches it consumed; the sidecars go with them.
    expect(await readUploadPageMeta(jobId, 'cagi', cagi, 1)).toBeNull();
  }, 240000);

  it("carries an explicit override through to the review payload", async () => {
    const jobId = 'job_meta_recognize_override';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();
    const overridden = { ...UNREGISTERED, overridden: true };

    expect((await uploadTestPage(
      jobId, 'cagi', cagi, 1, fs.readFileSync(cagiBlankPath),
      'cagi_page_001.png', 'image/png', overridden,
    )).status).toBe(200);
    expect((await uploadTestPage(
      jobId, 'satisfaction', satisfaction, 1, fs.readFileSync(satisfactionBlankPath),
      'satisfaction_page_001.png', 'image/png', UNVERIFIED,
    )).status).toBe(200);

    const drafts = await recognize(jobId, cagi, satisfaction, 'same');
    const { cagi: cagiVerdict, satisfaction: satVerdict } = drafts[0].sheetQuality;

    // F2.3: the override is visible, and it does NOT rescue the verdict.
    expect(cagiVerdict.verdict).toBe('unusable');
    expect(cagiVerdict.signals.registration?.overridden).toBe(true);
    expect(satVerdict.verdict).toBe('retake-suggested');
    expect(satVerdict.reasons).toEqual(['unverified-warp']);
  }, 240000);

  /**
   * The pairing test. `matchBatch` sorts both stacks by path and, under
   * 'reversed', reverses only the satisfaction list — so student 0 is handed
   * the LAST satisfaction page. Stored page numbers are never rewritten, so
   * the meta must follow the physical page and land on the other student.
   *
   * Each of the four sheets gets its own distinguishable verdict, and the two
   * orders are run over identical uploads. A verdict that followed the student
   * index instead of the page would leave the two runs identical.
   */
  async function uploadTwoStudentStacks(jobId: string) {
    const cagi = createTestBatch(2);
    const satisfaction = createTestBatch(2);
    const cagiBytes = fs.readFileSync(cagiBlankPath);
    const satisfactionBytes = fs.readFileSync(satisfactionBlankPath);

    // cagi page 1 -> retake-suggested, page 2 -> good.
    // satisfaction page 1 -> good, page 2 -> unusable.
    const uploads = [
      { type: 'cagi' as const, batch: cagi, page: 1, data: cagiBytes, meta: UNVERIFIED },
      { type: 'cagi' as const, batch: cagi, page: 2, data: cagiBytes, meta: makeRegistration() },
      { type: 'satisfaction' as const, batch: satisfaction, page: 1, data: satisfactionBytes, meta: makeRegistration() },
      { type: 'satisfaction' as const, batch: satisfaction, page: 2, data: satisfactionBytes, meta: UNREGISTERED },
    ];

    for (const upload of uploads) {
      const response = await uploadTestPage(
        jobId, upload.type, upload.batch, upload.page, upload.data,
        `${upload.type}_page_${String(upload.page).padStart(3, '0')}.png`,
        'image/png',
        upload.meta,
      );
      expect(response.status).toBe(200);
    }

    return { cagi, satisfaction };
  }

  it('follows the physical page when the back stack is paired in reverse', async () => {
    const forwardJob = 'job_meta_pairing_same';
    const forward = await uploadTwoStudentStacks(forwardJob);
    const sameDrafts = await recognize(forwardJob, forward.cagi, forward.satisfaction, 'same');

    const reversedJob = 'job_meta_pairing_reversed';
    const reversed = await uploadTwoStudentStacks(reversedJob);
    const reversedDrafts = await recognize(reversedJob, reversed.cagi, reversed.satisfaction, 'reversed');

    expect(sameDrafts).toHaveLength(2);
    expect(reversedDrafts).toHaveLength(2);

    const read = (drafts: Array<{ sheetQuality: Attachment }>) => drafts.map((draft) => ({
      cagi: draft.sheetQuality.cagi.verdict,
      satisfaction: draft.sheetQuality.satisfaction.verdict,
    }));

    // The front stack is never reversed, so the cagi column is identical in
    // both runs; only the satisfaction column swaps between the students.
    expect(read(sameDrafts)).toEqual([
      { cagi: 'retake-suggested', satisfaction: 'good' },
      { cagi: 'good', satisfaction: 'unusable' },
    ]);
    expect(read(reversedDrafts)).toEqual([
      { cagi: 'retake-suggested', satisfaction: 'unusable' },
      { cagi: 'good', satisfaction: 'good' },
    ]);

    // And the meta itself travelled, not just the verdict label.
    expect(reversedDrafts[0].sheetQuality.satisfaction.signals.registration).toEqual(UNREGISTERED);
    expect(reversedDrafts[1].sheetQuality.satisfaction.signals.registration).toEqual(makeRegistration());
  }, 600000);
});
