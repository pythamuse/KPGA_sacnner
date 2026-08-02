import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../src/lib/excel/templateManager';
import { POST as jobsPOST } from '../src/app/api/jobs/route';
import { POST as uploadPOST } from '../src/app/api/upload/route';
import { POST as recognizePOST } from '../src/app/api/recognize/route';
import { POST as studentsPOST } from '../src/app/api/students/route';
import { POST as downloadPOST } from '../src/app/api/download/route';

describe('엔드투엔드 API 통합 테스트 (일괄/스캔 대응)', () => {
  let jobId = '';
  let recognizedDraft: any = null;
  const confirmedStudents: any[] = [];

  afterAll(() => {
    // 임시 작업 폴더 정리
    if (jobId) {
      const dir = getJobDir(jobId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('1. POST /api/jobs — 작업 세션 및 템플릿 준비 성공', async () => {
    const response = await jobsPOST();
    expect(response.status).toBe(200);
    
    const body = await response.json();
    expect(body.jobId).toBeDefined();
    expect(body.jobId.startsWith('job_')).toBe(true);
    
    jobId = body.jobId;

    // 세션 디렉토리에 복사된 파일 검증
    const dir = getJobDir(jobId);
    expect(fs.existsSync(path.join(dir, '양식_청소년도박문제선별검사_CAGI_3.xlsx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '청소년예방교육만족도.xlsx'))).toBe(true);
  });

  it('1-1. POST /api/upload — 순차 업로드 재촬영 시 같은 타입 이전 파일 제거', async () => {
    const jobResponse = await jobsPOST();
    const { jobId: replacementJobId } = await jobResponse.json();
    const replacementJobDir = getJobDir(replacementJobId);

    try {
      const uploadOne = async (content: string) => {
        const formData = new FormData();
        formData.append('jobId', replacementJobId);
        formData.append('type', 'cagi');
        formData.append('replaceExisting', 'true');
        formData.append('file', new File([content], 'capture.jpg', { type: 'image/jpeg' }));

        const req = new Request('http://localhost/api/upload', {
          method: 'POST',
          body: formData,
        });

        return uploadPOST(req as any);
      };

      const first = await uploadOne('first-image');
      expect(first.status).toBe(200);

      const second = await uploadOne('second-image');
      expect(second.status).toBe(200);

      const uploadDir = path.join(replacementJobDir, 'uploads');
      const cagiFiles = fs.readdirSync(uploadDir).filter((filename) => filename.startsWith('cagi_'));
      expect(cagiFiles.length).toBe(1);

      const remainingFile = fs.readFileSync(path.join(uploadDir, cagiFiles[0]), 'utf8');
      expect(remainingFile).toBe('second-image');
    } finally {
      if (fs.existsSync(replacementJobDir)) {
        fs.rmSync(replacementJobDir, { recursive: true, force: true });
      }
    }
  });

  it('2. POST /api/recognize — 파일 묶음 분류, 정렬 매칭 및 드래프트 일괄 분석', async () => {
    const dir = getJobDir(jobId);
    const uploadDir = path.join(dir, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // 예시 모드로 판정되도록 파일명에 cagi와 satisfaction, 그리고 example(또는 류수민)을 가미하여 유효한 1x1 PNG 더미 파일 생성
    const cagiDummyPath = path.join(uploadDir, 'cagi_example_001.png');
    const satDummyPath = path.join(uploadDir, 'satisfaction_example_001.png');
    
    const png1x1 = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
      0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x60, 0x60, 0x60, 0x60,
      0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xA5, 0xF7, 0xDF, 0x7D, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);

    fs.writeFileSync(cagiDummyPath, png1x1);
    fs.writeFileSync(satDummyPath, png1x1);

    const req = new Request(`http://localhost/api/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId })
    });

    const response = await recognizePOST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.studentDrafts).toBeDefined();
    expect(body.studentDrafts.length).toBe(1);

    recognizedDraft = body.studentDrafts[0];
    expect(recognizedDraft.source.cagiImageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(recognizedDraft.source.satisfactionImageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(recognizedDraft.source.cropDataUrls).toBeDefined();
    expect(Object.keys(recognizedDraft.source.cropDataUrls).length).toBeGreaterThan(0);
    
    // 예시 데이터가 정확하게 식별되었는지 검증
    expect(recognizedDraft.basic.age).toBe(14);
    expect(recognizedDraft.basic.gender).toBe('여');
    expect(recognizedDraft.basic.schoolType).toBe('중학교');
    expect(recognizedDraft.basic.grade).toBe('2학년');
  });

  it('3. POST /api/students — 학생 데이터 유효성 검사 및 정밀 엑셀 쓰기', async () => {
    expect(recognizedDraft).not.toBeNull();

    // 클라이언트가 확정된 학생 전체 목록(새로 저장할 학생 포함)을 보낸다 -
    // 서버는 이전 요청이 만든 작업 파일에 의존하지 않고 매번 새로 만든다.
    const req = new Request(`http://localhost/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        students: [...confirmedStudents, recognizedDraft]
      })
    });

    const response = await studentsPOST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.row).toBe(3); // 첫 학생은 3행이어야 함
    expect(body.student.status).toBe('confirmed');
    expect(body.student.basic.gender).toBe('여'); // 정규화 여부 확인

    confirmedStudents.push(body.student);
  });

  it('4. POST /api/download — 파일별 정상 다운로드 여부 및 파일명 포맷 검증', async () => {
    // CAGI 다운로드 요청
    const reqCagi = new Request(`http://localhost/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'cagi', students: confirmedStudents })
    });
    const resCagi = await downloadPOST(reqCagi);
    expect(resCagi.status).toBe(200);
    expect(resCagi.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(decodeURIComponent(resCagi.headers.get('Content-Disposition') || '')).toContain('도박예방교육_CAGI_');

    // 만족도 다운로드 요청
    const reqSat = new Request(`http://localhost/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'satisfaction', students: confirmedStudents })
    });
    const resSat = await downloadPOST(reqSat);
    expect(resSat.status).toBe(200);
    expect(resSat.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(decodeURIComponent(resSat.headers.get('Content-Disposition') || '')).toContain('도박예방교육_만족도_');
  });

  it('5. POST /api/students — 검증 오류 전송 시 저장 차단 및 실패 응답', async () => {
    const invalidStudent = {
      source: { cagiImageId: 'cagi_example_001', satisfactionImageId: 'satisfaction_example_001' },
      basic: { age: 14, gender: '외계인', schoolType: '중학교', grade: '2학년' }, // 성별 에러
      cagi: { q01: 0, q02: 0, q03: 0, q04: 0, q05: 0, q06: 0, q07: 0, q08: 0, q09: 0 },
      satisfaction: { q01: 4, q02: 1, q03: 1, q04: 1, q05: 1, q06: 1, q07: 4, q08: 4, q09: 4, q10: 4 }
    };

    const req = new Request(`http://localhost/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, students: [...confirmedStudents, invalidStudent] })
    });

    const response = await studentsPOST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain('데이터 검증에 실패했습니다.');
    expect(body.errors.some((e: any) => e.code === 'INVALID_GENDER')).toBe(true);

    // 확정된 학생 수가 늘어나지 않았는지 확인 (실패했으므로 목록에 추가하지 않음)
    expect(confirmedStudents.length).toBe(1);
  });
});
