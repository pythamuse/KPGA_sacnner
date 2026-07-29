import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getJobDir } from '../../../../lib/excel/templateManager';
import { hasJobSession } from '../../../../lib/storage/jobStore';
import { loadImageAnalysisData } from '../../../../lib/recognition/markDensity';
import { cagiTemplate, ChoiceGroup, FieldRegion, NormalizedRect, satisfactionTemplate } from '../../../../lib/recognition/roiTemplates';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    const imageId = searchParams.get('imageId');
    const field = searchParams.get('field');
    const debug = searchParams.get('debug') === '1';

    if (!jobId || !imageId || !field) {
      return NextResponse.json({ error: 'jobId, imageId, field가 필요합니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다.' }, { status: 404 });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(imageId) || !/^[a-zA-Z0-9_.]+$/.test(field)) {
      return NextResponse.json({ error: '요청 식별자가 올바르지 않습니다.' }, { status: 400 });
    }

    const cropRect = findCropRect(field);
    if (!cropRect) {
      return NextResponse.json({ error: '해당 필드의 crop 영역이 정의되어 있지 않습니다.' }, { status: 404 });
    }

    const uploadDir = path.join(getJobDir(jobId), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      return NextResponse.json({ error: '업로드 이미지가 없습니다.' }, { status: 404 });
    }

    const filename = fs.readdirSync(uploadDir).find((candidate) => {
      const ext = path.extname(candidate).toLowerCase();
      return path.basename(candidate, ext) === imageId && imageExtensions.has(ext);
    });

    if (!filename) {
      return NextResponse.json({ error: '이미지를 찾을 수 없습니다.' }, { status: 404 });
    }

    const imagePath = path.join(uploadDir, filename);
    const analysis = await loadImageAnalysisData(imagePath);
    const cropBox = getCropBox(analysis, cropRect, debug ? 0.07 : 0.022);

    const extracted = sharp(imagePath)
      .rotate()
      .flatten({ background: '#ffffff' })
      .extract({
        left: cropBox.left,
        top: cropBox.top,
        width: cropBox.width,
        height: cropBox.height,
      })
      .resize({ width: 520, withoutEnlargement: true });

    const cropBuffer = debug
      ? await addDebugOverlay(extracted, cropBox, `${field} ${serializeRect(cropRect)}`)
      : await extracted.png().toBuffer();

    return new NextResponse(new Uint8Array(cropBuffer), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=300',
        'X-ROI-Field': field,
        'X-ROI-Rect': serializeRect(cropRect),
        'X-ROI-Crop-Box': serializeCropBox(cropBox),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `crop 이미지 생성 실패: ${err.message}` },
      { status: 500 },
    );
  }
}

function findChoiceGroup(field: string): ChoiceGroup | undefined {
  return [...cagiTemplate.choiceGroups, ...satisfactionTemplate.choiceGroups].find((group) => group.field === field);
}

function findFieldRegion(field: string): FieldRegion | undefined {
  return [...(cagiTemplate.fieldRegions || []), ...(satisfactionTemplate.fieldRegions || [])].find((region) => region.field === field);
}

function findCropRect(field: string): NormalizedRect | undefined {
  const group = findChoiceGroup(field);
  if (group) return getUnionRect(group);

  return findFieldRegion(field)?.rect;
}

function getUnionRect(group: ChoiceGroup): NormalizedRect {
  const left = Math.min(...group.candidates.map((candidate) => candidate.rect.x));
  const top = Math.min(...group.candidates.map((candidate) => candidate.rect.y));
  const right = Math.max(...group.candidates.map((candidate) => candidate.rect.x + candidate.rect.width));
  const bottom = Math.max(...group.candidates.map((candidate) => candidate.rect.y + candidate.rect.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function getCropBox(
  image: { width: number; height: number; contentBounds?: { left: number; top: number; right: number; bottom: number } },
  rect: NormalizedRect,
  paddingRatio: number,
): { left: number; top: number; width: number; height: number; roi: { left: number; top: number; width: number; height: number } } {
  const bounds = image.contentBounds || {
    left: 0,
    top: 0,
    right: image.width,
    bottom: image.height,
  };
  const baseWidth = bounds.right - bounds.left;
  const baseHeight = bounds.bottom - bounds.top;
  const paddingX = Math.max(8, Math.round(baseWidth * paddingRatio));
  const paddingY = Math.max(8, Math.round(baseHeight * paddingRatio));

  const roiLeft = Math.floor(bounds.left + rect.x * baseWidth);
  const roiTop = Math.floor(bounds.top + rect.y * baseHeight);
  const roiRight = Math.ceil(bounds.left + (rect.x + rect.width) * baseWidth);
  const roiBottom = Math.ceil(bounds.top + (rect.y + rect.height) * baseHeight);

  const left = clamp(roiLeft - paddingX, 0, image.width - 1);
  const top = clamp(roiTop - paddingY, 0, image.height - 1);
  const right = clamp(roiRight + paddingX, left + 1, image.width);
  const bottom = clamp(roiBottom + paddingY, top + 1, image.height);

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    roi: {
      left: roiLeft - left,
      top: roiTop - top,
      width: roiRight - roiLeft,
      height: roiBottom - roiTop,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function addDebugOverlay(
  image: sharp.Sharp,
  cropBox: { width: number; height: number; roi: { left: number; top: number; width: number; height: number } },
  label?: string,
): Promise<Buffer> {
  const { data, info } = await image.png().toBuffer({ resolveWithObject: true });
  const width = info.width || cropBox.width;
  const height = info.height || cropBox.height;
  const scaleX = width / cropBox.width;
  const scaleY = height / cropBox.height;
  const roi = {
    left: cropBox.roi.left * scaleX,
    top: cropBox.roi.top * scaleY,
    width: cropBox.roi.width * scaleX,
    height: cropBox.roi.height * scaleY,
  };
  const centerX = roi.left + roi.width / 2;
  const centerY = roi.top + roi.height / 2;
  const labelText = escapeSvgText(label || '');
  const overlay = Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#6855a0" stroke-width="2"/>
      <rect x="${roi.left}" y="${roi.top}" width="${roi.width}" height="${roi.height}" fill="none" stroke="#d83024" stroke-width="3"/>
      <line x1="${centerX}" y1="${Math.max(0, centerY - 9)}" x2="${centerX}" y2="${Math.min(height, centerY + 9)}" stroke="#d83024" stroke-width="2"/>
      <line x1="${Math.max(0, centerX - 9)}" y1="${centerY}" x2="${Math.min(width, centerX + 9)}" y2="${centerY}" stroke="#d83024" stroke-width="2"/>
      ${labelText ? `<rect x="8" y="8" width="${Math.min(width - 16, Math.max(180, labelText.length * 7 + 18))}" height="24" rx="4" fill="rgba(255,255,255,0.92)" stroke="#6855a0" stroke-width="1"/><text x="17" y="25" fill="#55438a" font-family="Arial, sans-serif" font-size="12" font-weight="700">${labelText}</text>` : ''}
    </svg>
  `);

  return sharp(data)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function serializeRect(rect: NormalizedRect): string {
  return `x=${rect.x};y=${rect.y};width=${rect.width};height=${rect.height}`;
}

function serializeCropBox(cropBox: { left: number; top: number; width: number; height: number }): string {
  return `left=${cropBox.left};top=${cropBox.top};width=${cropBox.width};height=${cropBox.height}`;
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
