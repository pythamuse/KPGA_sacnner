import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initJobWorkspace, loadJobWorkbooks, getJobDir, restoreExtLst, getTemplateFiles } from '../src/lib/excel/templateManager';
import { writeCagiRow, writeCpgiRow } from '../src/lib/excel/writeCagi';
import { writeSatisfactionRow, writeAdultSatisfactionRow } from '../src/lib/excel/writeSatisfaction';
import { verifyWorkbooks } from '../src/lib/excel/verifyWorkbook';
import { StudentData } from '../src/lib/validation/types';

const TEST_JOB_ID = 'test-job-excel';

describe('엑셀 입출력 및 보존 테스트', () => {
  const sampleStudent: StudentData = {
    source: { cagiImageId: 'img_cagi', satisfactionImageId: 'img_sat' },
    basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
    cagi: { q01: 0, q02: 0, q03: 0, q04: 0, q05: 0, q06: 0, q07: 0, q08: 0, q09: 0 },
    satisfaction: { q01: 4, q02: 1, q03: 1, q04: 1, q05: 1, q06: 1, q07: 4, q08: 4, q09: 4, q10: 4 },
    status: 'confirmed'
  };

  beforeAll(() => {
    // 테스트용 세션 초기화
    initJobWorkspace(TEST_JOB_ID);
  });

  afterAll(() => {
    // 테스트 세션 디렉토리 삭제
    const dir = getJobDir(TEST_JOB_ID);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('단일 학생 저장 및 엑셀 재검증 (드롭다운 보존 포함)', async () => {
    const { cagiWorkbook, satisfactionWorkbook, cagiPath, satisfactionPath } = await loadJobWorkbooks(TEST_JOB_ID);

    const cagiSheet = cagiWorkbook.getWorksheet('청소년도박문제선별검사')!;
    const satSheet = satisfactionWorkbook.getWorksheet('청소년예방교육만족도')!;

    // 3행에 샘플 데이터 작성
    writeCagiRow(cagiSheet, 3, sampleStudent);
    writeSatisfactionRow(satSheet, 3, sampleStudent);

    // 파일 저장
    await cagiWorkbook.xlsx.writeFile(cagiPath);
    await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

    // x14:dataValidations 드롭다운 유효성 검사 복원
    const origCagi = path.resolve(process.cwd(), 'templates', 'cagi', '양식_청소년도박문제선별검사_CAGI_3.xlsx');
    const origSat = path.resolve(process.cwd(), 'templates', 'satisfaction', '청소년예방교육만족도.xlsx');
    restoreExtLst(origCagi, cagiPath);
    restoreExtLst(origSat, satisfactionPath);

    // 저장된 파일 검증
    const result = await verifyWorkbooks(cagiPath, satisfactionPath, [sampleStudent]);
    
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('다중 학생(10명) 저장 및 엑셀 최종 행 일치성 검증', async () => {
    // 다시 새 템플릿으로 덮어씌움
    initJobWorkspace(TEST_JOB_ID);
    
    const { cagiWorkbook, satisfactionWorkbook, cagiPath, satisfactionPath } = await loadJobWorkbooks(TEST_JOB_ID);

    const cagiSheet = cagiWorkbook.getWorksheet('청소년도박문제선별검사')!;
    const satSheet = satisfactionWorkbook.getWorksheet('청소년예방교육만족도')!;

    const students: StudentData[] = [];
    for (let i = 0; i < 10; i++) {
      const student: StudentData = {
        ...sampleStudent,
        basic: {
          ...sampleStudent.basic,
          age: 14 + (i % 3) // 14, 15, 16 ...
        }
      };
      students.push(student);
      
      const row = 3 + i;
      writeCagiRow(cagiSheet, row, student);
      writeSatisfactionRow(satSheet, row, student);
    }

    await cagiWorkbook.xlsx.writeFile(cagiPath);
    await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

    // x14:dataValidations 드롭다운 유효성 검사 복원
    const origCagi = path.resolve(process.cwd(), 'templates', 'cagi', '양식_청소년도박문제선별검사_CAGI_3.xlsx');
    const origSat = path.resolve(process.cwd(), 'templates', 'satisfaction', '청소년예방교육만족도.xlsx');
    restoreExtLst(origCagi, cagiPath);
    restoreExtLst(origSat, satisfactionPath);

    const result = await verifyWorkbooks(cagiPath, satisfactionPath, students);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('성인 CPGI/만족도 엑셀 입출력 테스트', () => {
  const ADULT_TEST_JOB_ID = 'test-job-excel-adult';

  const sampleAdultStudent: StudentData = {
    track: 'adult',
    source: { cagiImageId: 'img_cpgi', satisfactionImageId: 'img_adult_sat' },
    basic: { age: 30, gender: '남' },
    cagi: { q01: 0, q02: 1, q03: 1, q04: 0, q05: 3, q06: 0, q07: 1, q08: 0, q09: 3 },
    satisfaction: { q01: 1, q02: 0, q03: 2, q04: 1, q05: 3, q06: 2, q07: 1, q08: 3, q09: 3, q10: 4 },
    status: 'confirmed'
  };

  beforeAll(() => {
    initJobWorkspace(ADULT_TEST_JOB_ID, 'adult');
  });

  afterAll(() => {
    const dir = getJobDir(ADULT_TEST_JOB_ID);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('성인 템플릿은 정확한 파일명(양식_성인도박문제선별검사_CPGI.xlsx / 성인예방교육만족도.xlsx)으로 복사된다', () => {
    const dir = getJobDir(ADULT_TEST_JOB_ID);
    expect(fs.existsSync(path.join(dir, '양식_성인도박문제선별검사_CPGI.xlsx'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '성인예방교육만족도.xlsx'))).toBe(true);
  });

  it('성인 컬럼 레이아웃(A=연령대,B=성별,C~=문항)으로 저장 및 드롭다운 보존 검증을 통과한다', async () => {
    const { cagiWorkbook, satisfactionWorkbook, cagiPath, satisfactionPath } = await loadJobWorkbooks(ADULT_TEST_JOB_ID, 'adult');

    const cagiSheet = cagiWorkbook.getWorksheet('성인도박문제선별검사')!;
    const satSheet = satisfactionWorkbook.getWorksheet('성인예방교육만족도')!;

    writeCpgiRow(cagiSheet, 3, sampleAdultStudent);
    writeAdultSatisfactionRow(satSheet, 3, sampleAdultStudent);

    await cagiWorkbook.xlsx.writeFile(cagiPath);
    await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

    const templates = getTemplateFiles('adult');
    restoreExtLst(templates.cagiPath, cagiPath, '성인도박문제선별검사');
    restoreExtLst(templates.satisfactionPath, satisfactionPath, '성인예방교육만족도');

    // 학교유형/학년 컬럼이 없으므로 CPGI 01은 C열, 만족도 문항1은 C열에 바로 온다.
    expect(cagiSheet.getCell('A3').value).toBe(30);
    expect(cagiSheet.getCell('B3').value).toBe('남');
    expect(cagiSheet.getCell('C3').value).toBe(0);
    expect(cagiSheet.getCell('K3').value).toBe(3); // CPGI 09

    expect(satSheet.getCell('A3').value).toBe(30);
    expect(satSheet.getCell('C3').value).toBe(1); // 문항1
    expect(satSheet.getCell('L3').value).toBe(4); // 문항10

    const result = await verifyWorkbooks(cagiPath, satisfactionPath, [sampleAdultStudent], 'adult');
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
