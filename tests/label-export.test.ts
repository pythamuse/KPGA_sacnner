import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import {
  appendRecognitionLabels,
  getLabelJsonlPath,
  readRecognitionMeasurements,
  resetLabelExportForTests,
  resolveLabelSource,
  storeRecognitionMeasurements,
} from '../src/lib/labelExport/labelStore';
import type { RecognitionCandidateMeasurement } from '../src/lib/labelExport/types';

const jobId = `job_label_export_${process.pid}`;
const cagiImageId = 'cagi_page_0001';
const originalVercel = process.env.VERCEL;

function measurement(candidateIndex: number, candidateValue: number | string): RecognitionCandidateMeasurement {
  return {
    field: 'basic.schoolType',
    candidateValue,
    candidateIndex,
    score: 0.1 + candidateIndex / 100,
    actualInk: 0.2,
    baselineInk: 0.1,
    brightnessOffset: 2,
    alignX: candidateIndex,
    alignY: candidateIndex === 0 ? 0 : -candidateIndex,
    largestComponentSize: 8,
    largestComponentRatio: 0.4,
    diagonalRatio: 0.3,
    registrationStatus: 'verified',
    cropSource: 'grid',
    pageInkRatio: 0.08,
    pageIsBinarySource: true,
    confidence: 'high',
    autoFilled: true,
  };
}

const measurements = {
  'basic.schoolType': [
    measurement(0, '초등학교'),
    measurement(1, '중학교'),
    measurement(2, '고등학교'),
    measurement(3, '학교외기관'),
  ],
};

function studentWithSource(source: string) {
  return {
    source: {
      cagiImageId,
      satisfactionImageId: 'satisfaction_page_0001',
      recognitionValueSource: { 'basic.schoolType': source },
    },
    basic: { schoolType: '중학교' },
    cagi: {},
    satisfaction: {},
  };
}

afterEach(async () => {
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  await resetLabelExportForTests(jobId);
});

describe('offline recognition label export', () => {
  it('keeps measurements server-side and emits one labeled row per candidate', async () => {
    await storeRecognitionMeasurements({
      jobId,
      studentIndex: 0,
      cagiImageId,
      measurements,
    });

    await expect(readRecognitionMeasurements(jobId, cagiImageId)).resolves.toMatchObject({
      jobId,
      studentIndex: 0,
      cagiImageId,
      measurements,
    });

    const rows = await appendRecognitionLabels({
      jobId,
      studentIndex: 0,
      cagiImageId,
      student: studentWithSource('confirmed'),
    });

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.candidateIndex)).toEqual([0, 1, 2, 3]);
    expect(rows.map((row) => row.label)).toEqual([0, 1, 0, 0]);
    expect(rows.every((row) => row.labelSource === 'confirmed')).toBe(true);
    expect(rows[1]).toMatchObject({
      jobId,
      studentIndex: 0,
      field: 'basic.schoolType',
      candidateValue: '중학교',
      score: 0.11,
      actualInk: 0.2,
      baselineInk: 0.1,
      brightnessOffset: 2,
      alignX: 1,
      alignY: -1,
      largestComponentSize: 8,
      largestComponentRatio: 0.4,
      diagonalRatio: 0.3,
      registrationStatus: 'verified',
      cropSource: 'grid',
      pageInkRatio: 0.08,
      pageIsBinarySource: true,
      confidence: 'high',
      autoFilled: true,
    });

    const lines = (await fs.readFile(getLabelJsonlPath(jobId), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatchObject({ candidateValue: '중학교', label: 1 });
  });

  it('appends a second save and records blank_ok as four zero labels', async () => {
    await storeRecognitionMeasurements({
      jobId,
      studentIndex: 0,
      cagiImageId,
      measurements,
    });

    await appendRecognitionLabels({
      jobId,
      studentIndex: 0,
      cagiImageId,
      student: studentWithSource('confirmed'),
    });
    const blankRows = await appendRecognitionLabels({
      jobId,
      studentIndex: 0,
      cagiImageId,
      student: {
        ...studentWithSource('blank_ok'),
        basic: {},
      },
    });

    expect(blankRows.map((row) => row.label)).toEqual([0, 0, 0, 0]);
    expect(blankRows.every((row) => row.labelSource === 'blank_ok')).toBe(true);

    const lines = (await fs.readFile(getLabelJsonlPath(jobId), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(8);
  });

  it('keeps restored values as restored weak labels', async () => {
    await storeRecognitionMeasurements({
      jobId,
      studentIndex: 0,
      cagiImageId,
      measurements,
    });

    const rows = await appendRecognitionLabels({
      jobId,
      studentIndex: 0,
      cagiImageId,
      student: studentWithSource('restored'),
    });

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.labelSource === 'restored')).toBe(true);
  });

  it('does not write any label data when Vercel is present', async () => {
    process.env.VERCEL = '1';

    await storeRecognitionMeasurements({
      jobId,
      studentIndex: 0,
      cagiImageId,
      measurements,
    });
    await appendRecognitionLabels({
      jobId,
      studentIndex: 0,
      cagiImageId,
      student: studentWithSource('confirmed'),
    });

    await expect(fs.access(getLabelJsonlPath(jobId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readRecognitionMeasurements(jobId, cagiImageId)).resolves.toBeUndefined();
  });

  it('only treats explicit auto as the automatic source', () => {
    expect(resolveLabelSource('auto')).toBe('auto');
    expect(resolveLabelSource('restored', new Date().toISOString())).toBe('restored');
    expect(resolveLabelSource('confirmed')).toBe('confirmed');
    expect(resolveLabelSource('blank_ok')).toBe('blank_ok');
    expect(resolveLabelSource('manual')).toBe('manual');
    expect(resolveLabelSource('unresolved')).toBe('manual');
  });
});
