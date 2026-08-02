import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import { StudentData } from '../validation/types';
import { getTemplateFiles, restoreExtLst } from './templateManager';
import { writeCagiRow } from './writeCagi';
import { writeSatisfactionRow } from './writeSatisfaction';
import { verifyWorkbooks, VerifyResult } from './verifyWorkbook';

export interface GeneratedWorkbookPair {
  cagiBuffer: Buffer;
  satisfactionBuffer: Buffer;
  verifyResult: VerifyResult;
}

/**
 * 확정된 학생 전체 목록으로부터 CAGI/만족도 엑셀 두 개를 매번 새로 만든다.
 *
 * 이전 요청이 만들어 둔 작업 파일에 의존하지 않는다 - Vercel처럼 요청이 서로 다른
 * 서버리스 인스턴스로 분산되는 환경에서는 그 파일이 현재 인스턴스의 로컬 디스크에
 * 없을 수 있기 때문이다(실제로 /api/students, /api/uploads/crop가 이 문제로
 * "작업 세션이 존재하지 않습니다" 404를 반환하는 사례를 확인했다).
 *
 * 대신 매 호출마다 레포에 번들된 원본 템플릿(모든 인스턴스에 항상 존재)에서
 * 다시 시작해 클라이언트가 들고 있는 학생 목록 전체를 처음부터 다시 쓴다.
 * 이렇게 하면 이 함수 하나의 실행 범위 밖 상태에는 전혀 의존하지 않는다.
 *
 * 임시 작업 파일은 요청별로 유일한 스크래치 디렉터리를 써서, 동시에 들어온
 * 다른 요청과 파일 경로가 겹쳐 서로의 쓰기를 덮어쓰는 일이 없게 한다.
 */
export async function generateWorkbookPair(students: StudentData[]): Promise<GeneratedWorkbookPair> {
  const templates = getTemplateFiles();
  const scratchDir = path.join(os.tmpdir(), 'kpga-sacnner', 'scratch', crypto.randomUUID());
  fs.mkdirSync(scratchDir, { recursive: true });

  const cagiPath = path.join(scratchDir, path.basename(templates.cagiPath));
  const satisfactionPath = path.join(scratchDir, path.basename(templates.satisfactionPath));

  try {
    fs.copyFileSync(templates.cagiPath, cagiPath);
    fs.copyFileSync(templates.satisfactionPath, satisfactionPath);

    const cagiWorkbook = new ExcelJS.Workbook();
    const satisfactionWorkbook = new ExcelJS.Workbook();
    await cagiWorkbook.xlsx.readFile(cagiPath);
    await satisfactionWorkbook.xlsx.readFile(satisfactionPath);

    const cagiSheet = cagiWorkbook.getWorksheet('청소년도박문제선별검사');
    const satSheet = satisfactionWorkbook.getWorksheet('청소년예방교육만족도');

    if (!cagiSheet || !satSheet) {
      throw new Error('템플릿에서 필요한 시트를 찾을 수 없습니다.');
    }

    students.forEach((student, index) => {
      const row = 3 + index;
      writeCagiRow(cagiSheet, row, student);
      writeSatisfactionRow(satSheet, row, student);
    });

    await cagiWorkbook.xlsx.writeFile(cagiPath);
    await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

    // 드롭다운 유효성 검사(x14:dataValidations) 복원
    restoreExtLst(templates.cagiPath, cagiPath);
    restoreExtLst(templates.satisfactionPath, satisfactionPath);

    const verifyResult = await verifyWorkbooks(cagiPath, satisfactionPath, students);

    return {
      cagiBuffer: fs.readFileSync(cagiPath),
      satisfactionBuffer: fs.readFileSync(satisfactionPath),
      verifyResult,
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
