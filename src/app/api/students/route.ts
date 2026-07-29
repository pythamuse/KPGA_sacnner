import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { validateStudent } from '../../../lib/validation/validateStudent';
import { 
  normalizeGender, 
  normalizeSchoolType, 
  normalizeGrade, 
  normalizeAge 
} from '../../../lib/validation/normalize';
import { getJobSession, addStudentToSession } from '../../../lib/storage/jobStore';
import { 
  loadJobWorkbooks, 
  restoreExtLst, 
  backupJobFiles, 
  rollbackJobFiles, 
  commitJobFiles 
} from '../../../lib/excel/templateManager';
import { writeCagiRow } from '../../../lib/excel/writeCagi';
import { writeSatisfactionRow } from '../../../lib/excel/writeSatisfaction';
import { verifyWorkbooks } from '../../../lib/excel/verifyWorkbook';

export async function POST(req: NextRequest) {
  let jobId = '';
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
    student.basic.schoolType = normalizeSchoolType(student.basic.schoolType);
    student.basic.grade = normalizeGrade(student.basic.grade);
    student.basic.age = normalizeAge(student.basic.age);

    // 2. 트랜잭션 백업
    backupJobFiles(jobId);

    // 3. 엑셀 데이터 쓰기
    const { cagiWorkbook, satisfactionWorkbook, cagiPath, satisfactionPath } = await loadJobWorkbooks(jobId);
    const cagiSheet = cagiWorkbook.getWorksheet('청소년도박문제선별검사')!;
    const satSheet = satisfactionWorkbook.getWorksheet('청소년예방교육만족도')!;

    // 행 번호 결정 (3행부터 시작)
    const targetRow = 3 + session.students.length;

    // 데이터 쓰기
    writeCagiRow(cagiSheet, targetRow, student);
    writeSatisfactionRow(satSheet, targetRow, student);

    // 파일 저장
    await cagiWorkbook.xlsx.writeFile(cagiPath);
    await satisfactionWorkbook.xlsx.writeFile(satisfactionPath);

    // 드롭다운 유효성 검사 복원
    const origCagi = path.resolve(process.cwd(), 'templates', 'cagi', '양식_청소년도박문제선별검사_CAGI_3.xlsx');
    const origSat = path.resolve(process.cwd(), 'templates', 'satisfaction', '청소년예방교육만족도.xlsx');
    restoreExtLst(origCagi, cagiPath);
    restoreExtLst(origSat, satisfactionPath);

    // 4. 저장 후 재읽기 자체 검증
    const updatedStudents = [...session.students, student];
    const verifyResult = await verifyWorkbooks(cagiPath, satisfactionPath, updatedStudents);

    if (!verifyResult.ok) {
      // 자가 검증 실패 시 롤백
      rollbackJobFiles(jobId);
      return NextResponse.json({ 
        error: '엑셀 저장 후 무결성 검증 실패 (롤백됨)', 
        errors: verifyResult.errors.map(msg => ({ code: 'INTEGRITY_ERROR', message: msg }))
      }, { status: 500 });
    }

    // 5. 성공 시 커밋 및 세션 저장
    commitJobFiles(jobId);
    
    // 학생 상태를 confirmed로 변경하여 저장
    const savedStudent = {
      ...student,
      studentIndex: targetRow,
      status: 'confirmed'
    };
    addStudentToSession(jobId, savedStudent);

    return NextResponse.json({
      ok: true,
      row: targetRow,
      student: savedStudent
    });

  } catch (err: any) {
    if (jobId) {
      rollbackJobFiles(jobId);
    }
    return NextResponse.json(
      { error: `학생 저장 처리 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
