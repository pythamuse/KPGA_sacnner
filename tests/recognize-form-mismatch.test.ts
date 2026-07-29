import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getJobDir } from '../src/lib/excel/templateManager';
import { ChoiceGroup } from '../src/lib/recognition/roiTemplates';
import { POST as jobsPOST } from '../src/app/api/jobs/route';
import { POST as recognizePOST } from '../src/app/api/recognize/route';

const createdJobDirs: string[] = [];

const satisfactionGroups: ChoiceGroup[] = [
  makeChoiceGroup('satisfaction.frequency', [1, 2, 3, 4], [0.668, 0.748, 0.827, 0.908], 0.35, 0.025),
  ...[0.462, 0.507, 0.552, 0.596].map((y, index) =>
    makeChoiceGroup(`satisfaction.yn${index + 2}`, [0, 1], [0.815, 0.903], y, 0.022),
  ),
  ...[0.723, 0.765, 0.806, 0.848].map((y, index) =>
    makeChoiceGroup(`satisfaction.rating${index + 7}`, [0, 1, 2, 3, 4], [0.595, 0.686, 0.777, 0.866, 0.945], y, 0.022),
  ),
];

afterAll(() => {
  for (const jobDir of createdJobDirs) {
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }
});

describe('인식 API 양식 칸 불일치 감지', () => {
  it('CAGI 칸에 만족도 양식 이미지가 업로드되면 FORM_TYPE_MISMATCH를 반환한다', async () => {
    const jobResponse = await jobsPOST();
    const { jobId } = await jobResponse.json();
    const jobDir = getJobDir(jobId);
    createdJobDirs.push(jobDir);

    const uploadDir = path.join(jobDir, 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    await writeSyntheticForm(path.join(uploadDir, 'cagi_wrong_bucket.png'), satisfactionGroups);

    const req = new Request('http://localhost/api/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });

    const response = await recognizePOST(req as any);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.code).toBe('FORM_TYPE_MISMATCH');
    expect(body.mismatches).toEqual([
      {
        filename: 'cagi_wrong_bucket.png',
        uploadedAs: 'cagi',
        detectedAs: 'satisfaction',
      },
    ]);
  });
});

async function writeSyntheticForm(filePath: string, groups: ChoiceGroup[]) {
  const width = 1000;
  const height = 1400;
  const bounds = {
    left: 100,
    top: 100,
    width: 800,
    height: 1200,
  };

  const circles = groups.flatMap((group) =>
    group.candidates.map((candidate) => {
      const cx = bounds.left + (candidate.rect.x + candidate.rect.width / 2) * bounds.width;
      const cy = bounds.top + (candidate.rect.y + candidate.rect.height / 2) * bounds.height;
      const radius = Math.max(candidate.rect.width * bounds.width, candidate.rect.height * bounds.height) * 0.52;
      return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#000" stroke-width="8"/>`;
    }),
  );

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      <rect x="${bounds.left}" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="#000" stroke-width="6"/>
      ${circles.join('\n')}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function makeChoiceGroup(
  field: string,
  values: number[],
  xs: number[],
  y: number,
  size: number,
): ChoiceGroup {
  return {
    field,
    candidates: values.map((value, index) => ({
      value,
      rect: {
        x: xs[index] - size / 2,
        y: y - size / 2,
        width: size,
        height: size,
      },
    })),
  };
}
