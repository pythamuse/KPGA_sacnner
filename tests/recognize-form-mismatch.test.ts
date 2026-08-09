import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { FORM_CLASSIFIER_POLICY_VERSION } from '../src/lib/recognition/classifyForm';
import { GET as recognizeGET, POST as recognizePOST } from '../src/app/api/recognize/route';
import { resetUploadStoreForTests } from '../src/lib/storage/uploadStore';
import { createInventory, createTestBatch, uploadTestPage } from './helpers/uploadApi';

const satisfactionGroups: ChoiceGroup[] = [
  makeChoiceGroup('satisfaction.frequency', [1, 2, 3, 4], [0.668, 0.748, 0.827, 0.908], 0.35, 0.025),
  ...[0.462, 0.507, 0.552, 0.596].map((y, index) =>
    makeChoiceGroup(`satisfaction.yn${index + 2}`, [0, 1], [0.815, 0.903], y, 0.022),
  ),
  ...[0.723, 0.765, 0.806, 0.848].map((y, index) =>
    makeChoiceGroup(`satisfaction.rating${index + 7}`, [0, 1, 2, 3, 4], [0.595, 0.686, 0.777, 0.866, 0.945], y, 0.022),
  ),
];

afterEach(() => {
  resetUploadStoreForTests();
});

describe('recognition upload-bucket checks', () => {
  it('returns the current classifier policy version', async () => {
    const response = recognizeGET();
    await expect(response.json()).resolves.toEqual({
      service: 'recognize',
      recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
    });
  });

  it('detects a satisfaction form uploaded to the CAGI bucket', async () => {
    const jobId = 'job_form_mismatch';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();
    const wrongBucket = await buildSyntheticForm(satisfactionGroups);
    const blankPage = await buildBlankPage();

    await uploadTestPage(jobId, 'cagi', cagi, 1, wrongBucket);
    await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, blankPage);

    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction) }),
    }) as any);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'FORM_TYPE_MISMATCH',
      recognitionPolicyVersion: FORM_CLASSIFIER_POLICY_VERSION,
      canProceedWithUploadedTypes: true,
      mismatches: [{
        filename: 'cagi_page_0001.jpg',
        uploadedAs: 'cagi',
        detectedAs: 'satisfaction',
      }],
    });
  });

  it('keeps unknown-content pages in their selected upload buckets', async () => {
    const jobId = 'job_unknown_form';
    const cagi = createTestBatch();
    const satisfaction = createTestBatch();
    const blankPage = await buildBlankPage();

    await uploadTestPage(jobId, 'cagi', cagi, 1, blankPage);
    await uploadTestPage(jobId, 'satisfaction', satisfaction, 1, blankPage);

    const response = await recognizePOST(new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, inventory: createInventory(cagi, satisfaction) }),
    }) as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      studentDrafts: expect.any(Array),
    });
  });
});

async function buildBlankPage() {
  return sharp({
    create: { width: 320, height: 480, channels: 3, background: '#ffffff' },
  }).png().toBuffer();
}

async function buildSyntheticForm(groups: ChoiceGroup[]) {
  const width = 1000;
  const height = 1400;
  const bounds = { left: 100, top: 100, width: 800, height: 1200 };
  const circles = groups.flatMap((group) => group.candidates.map((candidate) => {
    const cx = bounds.left + (candidate.rect.x + candidate.rect.width / 2) * bounds.width;
    const cy = bounds.top + (candidate.rect.y + candidate.rect.height / 2) * bounds.height;
    const radius = Math.max(candidate.rect.width * bounds.width, candidate.rect.height * bounds.height) * 0.52;
    return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#000" stroke-width="8"/>`;
  }));

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#000" stroke-width="6"/>
      ${circles.join('\n')}
    </svg>
  `;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function makeChoiceGroup(field: string, values: number[], xs: number[], y: number, size: number): ChoiceGroup {
  return {
    field,
    candidates: values.map((value, index) => ({
      value,
      rect: { x: xs[index] - size / 2, y: y - size / 2, width: size, height: size },
    })),
  };
}
