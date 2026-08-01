import { NextRequest, NextResponse } from 'next/server';
import { validateStudent } from '../../../lib/validation/validateStudent';
import {
  normalizeGender,
  normalizeSchoolType,
  normalizeGrade,
  normalizeAge,
  normalizeAdultAgeBand,
} from '../../../lib/validation/normalize';
import { getJobSession, addStudentToSession, withJobLock } from '../../../lib/storage/jobStore';
import {
  loadJobWorkbooks,
  restoreExtLst,
  backupJobFiles,
  rollbackJobFiles,
  commitJobFiles,
  getTemplateFiles,
  FormTrack,
} from '../../../lib/excel/templateManager';
import { writeCagiRow, writeCpgiRow } from '../../../lib/excel/writeCagi';
import { writeSatisfactionRow, writeAdultSatisfactionRow } from '../../../lib/excel/writeSatisfaction';
import { verifyWorkbooks } from '../../../lib/excel/verifyWorkbook';

const CAGI_SHEET_NAMES: Record<FormTrack, string> = {
  youth: '청소년도박문제선별검사',
  adult: '성인도박문제선별검사',
};
const SATISFACTION_SHEET_NAMES: Record<FormTrack, string> = {
  youth: '청소년예방교육만족도',
  adult: '성인예방교육만족도',
};

export async function POST(req: NextRequest) {
  let jobId = '';
  let track: FormTrack = 'youth';
  try {
    const { jobId: reqJobId, student } = await req.json();
    jobId = reqJobId;

    if (!jobId || !student) {
      return NextResponse.json({ error: '필수 파라미터가 누락되었습니다.' }, { status: 400 });
    }

    const session = getJobSession(jobId);
    if (!session) {
      return NextResponse.json({ error: '유효하지 않은 작업 세션입니다.' }, { status: 404 });
    }

    track = session.track;
    student.track = track;

    // 1. 학생 데이터 유효성 검증
    const validation = validateStudent(student);
    if (!validation.ok) {
      return NextResponse.json({
        error: '데이터 검증에 실패했습니다.',
        errors: validation.errors
      }, { status: 400 });
    }

    // 정규화된 값을 student 객체에 명시적으로 반영
    student.basic.gender = normalizeGender(student.basic.gender);
    if (track === 'adult') {
      student.basic.age = normalizeAdultAgeBand(student.basic.age);
    } else {
      student.basic.schoolType = normalizeSchoolType(student.basic.schoolType);
      student.basic.grade = normalizeGrade(student.basic.grade);
      student.basic.age = normalizeAge(student.basic.age);
    }

    const cagiSheetName = CAGI_SHEET_NAMES[track];
    const satSheetName = SATISFACTION_SHEET_NAMES[track];
    const writeCagi = track === 'adult' ? writeCpgiRow : writeCagiRow;
    const writeSatisfaction = track === 'adult' ? writeAdultSatisfactionRow : writeSatisfactionRow;

    // 같은 jobId에 대한 저장 요청을 직렬화한다(더블클릭/다중 탭 방지).
    // targetRow 계산은 반드시 락 안에서 최신 세션 기준으로 다시 해야 한다.
    const result = await withJobLock(jobId, async () => {
      const latestSession = getJobSession(jobId);
      if (!latestSession) {
        throw new Error('유효하지 않은 작업 세션입니다.');
      }

      // 2. 트랜잭션 백업
      backupJobFiles(jobId, track);

      // 3. 엑셀 데이터 쓰기
      const { cagiWorkbook, satisfactionWorkbook, cagiPath, satisfactionPath } = await loadJobWorkbooks(jobId, track);
      const cagiSheet = cagiWorkbook.getWorksheet(cagiSheetName)!;
      const satSheet = satisfactionWorkbook.getWorksheet(satSheetName)!;

      // 행 번호 결정 (3행부터 시작, 락 안에서 최신 학생 수 기준으로 계산)
      const targetRow = 3 + latestSession.students.length;

      // 데이터 쓰기
      writeCagi(cagiSheet, targetRow, student);
      writeSatisfaction(satSheet, targetRow, student);

      // 파일 저장
      await cagiWorkbook.xlsx.writeFile(cagiPath);
      await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

      // 드롭다운 유효성 검사 복원
      const templates = getTemplateFiles(track);
      restoreExtLst(templates.cagiPath, cagiPath, cagiSheetName);
      restoreExtLst(templates.satisfactionPath, satisfactionPath, satSheetName);

      // 4. 저장 후 재읽기 자체 검증
      const updatedStudents = [...latestSession.students, student];
      const verifyResult = await verifyWorkbooks(cagiPath, satisfactionPath, updatedStudents, track);

      if (!verifyResult.ok) {
        // 자가 검증 실패 시 롤백
        rollbackJobFiles(jobId, track);
        return {
          ok: false as const,
          errors: verifyResult.errors.map(msg => ({ code: 'INTEGRITY_ERROR', message: msg })),
        };
      }

      // 5. 성공 시 커밋 및 세션 저장
      commitJobFiles(jobId, track);

      // 학생 상태를 confirmed로 변경하여 저장
      const savedStudent = {
        ...student,
        studentIndex: targetRow,
        status: 'confirmed'
      };
      addStudentToSession(jobId, savedStudent);

      return { ok: true as const, row: targetRow, student: savedStudent };
    });

    if (!result.ok) {
      return NextResponse.json({
        error: '엑셀 저장 후 무결성 검증 실패 (롤백됨)',
        errors: result.errors
      }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      row: result.row,
      student: result.student
    });

  } catch (err: any) {
    if (jobId) {
      rollbackJobFiles(jobId, track);
    }
    return NextResponse.json(
      { error: `학생 저장 처리 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
