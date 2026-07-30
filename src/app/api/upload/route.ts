import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../../../lib/excel/templateManager';
import { ensureJobSession } from '../../../lib/storage/jobStore';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const jobId = formData.get('jobId') as string;
    const type = formData.get('type') as string;
    const replaceExisting = formData.get('replaceExisting') === 'true';

    if (!file || !jobId || !['cagi', 'satisfaction'].includes(type)) {
      return NextResponse.json({ error: '필수 파라미터가 누락되었습니다.' }, { status: 400 });
    }

    if (!ensureJobSession(jobId)) {
      return NextResponse.json({ error: '작업 세션이 유효하지 않습니다. 새 작업을 시작해주세요.' }, { status: 404 });
    }

    const jobDir = getJobDir(jobId);
    const uploadDir = path.join(jobDir, 'uploads');
    
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    if (replaceExisting) {
      const removablePrefix = `${type}_`;
      fs.readdirSync(uploadDir)
        .filter((filename) => filename.startsWith(removablePrefix))
        .forEach((filename) => {
          fs.unlinkSync(path.join(uploadDir, filename));
        });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileExt = path.extname(file.name);
    const imageId = `${type}_${Date.now()}`;
    const filename = `${imageId}${fileExt}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, buffer);

    return NextResponse.json({
      imageId,
      filename,
      originalName: file.name
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `이미지 업로드 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
