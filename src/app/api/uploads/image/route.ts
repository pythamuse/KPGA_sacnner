import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../../../../lib/excel/templateManager';
import { hasJobSession } from '../../../../lib/storage/jobStore';

const contentTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    const imageId = searchParams.get('imageId');

    if (!jobId || !imageId) {
      return NextResponse.json({ error: 'jobId와 imageId가 필요합니다.' }, { status: 400 });
    }

    if (!hasJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 존재하지 않습니다.' }, { status: 404 });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(imageId)) {
      return NextResponse.json({ error: '이미지 식별자가 올바르지 않습니다.' }, { status: 400 });
    }

    const uploadDir = path.join(getJobDir(jobId), 'uploads');
    if (!fs.existsSync(uploadDir)) {
      return NextResponse.json({ error: '업로드 이미지가 없습니다.' }, { status: 404 });
    }

    const filename = fs.readdirSync(uploadDir).find((candidate) => {
      const ext = path.extname(candidate).toLowerCase();
      return path.basename(candidate, ext) === imageId && contentTypes[ext];
    });

    if (!filename) {
      return NextResponse.json({ error: '이미지를 찾을 수 없습니다.' }, { status: 404 });
    }

    const ext = path.extname(filename).toLowerCase();
    const imagePath = path.join(uploadDir, filename);
    const imageBuffer = fs.readFileSync(imagePath);

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentTypes[ext],
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `이미지 로드 실패: ${err.message}` },
      { status: 500 },
    );
  }
}
