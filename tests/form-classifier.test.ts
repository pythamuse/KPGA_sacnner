import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { classifyForm } from '../src/lib/recognition/classifyForm';
import {
  cagiTemplate,
  ChoiceGroup,
  FormRecognitionTemplate,
  satisfactionTemplate,
} from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-form-classifier');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('이미지 내용 기반 양식 판별', () => {
  it('파일명이 애매해도 CAGI 선택지 구조를 감지한다', async () => {
    const filePath = path.join(fixtureDir, 'unknown-front.png');
    await writeSyntheticForm(filePath, cagiTemplate);

    await expect(classifyForm(filePath)).resolves.toBe('cagi');
  });

  it('파일명이 cagi여도 만족도 선택지 구조가 더 강하면 만족도로 판별한다', async () => {
    const filePath = path.join(fixtureDir, 'cagi_wrong_bucket.png');
    await writeSyntheticForm(filePath, satisfactionTemplate);

    await expect(classifyForm(filePath)).resolves.toBe('satisfaction');
  });

  it('기존 example fixture는 파일명 힌트를 유지한다', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction_example_001.png');
    await writeTinyPng(filePath);

    await expect(classifyForm(filePath)).resolves.toBe('satisfaction');
  });

  it('테두리를 감지하지 못하는 사진(휴대폰 촬영 등)은 내용 분석 대신 파일명 힌트를 따른다', async () => {
    const filePath = path.join(fixtureDir, 'satisfaction_no_frame.png');
    await writeSyntheticFormWithoutFrame(filePath, cagiTemplate.choiceGroups);

    await expect(classifyForm(filePath)).resolves.toBe('satisfaction');
  });
});

async function writeSyntheticForm(filePath: string, template: FormRecognitionTemplate) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const width = 1000;
  const height = 1400;
  const registrationFrame = template.registrationFrame || { x: 0, y: 0, width: 1, height: 1 };
  const bounds = {
    left: Math.round(registrationFrame.x * width),
    top: Math.round(registrationFrame.y * height),
    width: Math.round(registrationFrame.width * width),
    height: Math.round(registrationFrame.height * height),
  };

  const circles = template.choiceGroups.flatMap((group) =>
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

async function writeSyntheticFormWithoutFrame(filePath: string, groups: ChoiceGroup[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

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

  // 실제 종이 테두리(직선)가 없는, 원근 왜곡된 휴대폰 촬영 사진을 흉내낸다 -
  // detectFrameBounds가 감지할 만한 긴 직선(가로/세로) 없이 체크 표시만 남긴다.
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      ${circles.join('\n')}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function writeTinyPng(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: '#ffffff',
    },
  }).png().toFile(filePath);
}
