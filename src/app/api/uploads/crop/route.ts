import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../../../../lib/excel/templateManager';
import { hasJobSession } from '../../../../lib/storage/jobStore';
import { applyTemplateRegistrationFrame, loadImageAnalysisData } from '../../../../lib/recognition/markDensity';
import { findCropRect, generateFieldCropBuffer, getCropBox, serializeCropBox, serializeRect } from '../../../../lib/recognition/fieldCrop';
import { cagiTemplate, satisfactionTemplate } from '../../../../lib/recognition/roiTemplates';

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
    const template = field.startsWith('satisfaction.') ? satisfactionTemplate : cagiTemplate;
    const analysis = applyTemplateRegistrationFrame(
      await loadImageAnalysisData(imagePath),
      template.registrationFrame,
    );
    const cropBox = getCropBox(analysis, cropRect, debug ? 0.07 : 0.022);

    const cropBuffer = await generateFieldCropBuffer(imagePath, field, debug);
    if (!cropBuffer) {
      return NextResponse.json({ error: '해당 필드의 crop 영역이 정의되어 있지 않습니다.' }, { status: 404 });
    }

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
