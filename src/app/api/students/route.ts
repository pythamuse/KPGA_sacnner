import { NextResponse } from 'next/server';
import { validateStudent } from '../../../lib/validation/validateStudent';
import {
  normalizeGender,
  normalizeSchoolType,
  normalizeGrade,
  normalizeAge
} from '../../../lib/validation/normalize';
import { generateWorkbookPair } from '../../../lib/excel/generateWorkbookPair';
import { StudentData } from '../../../lib/validation/types';
import { appendRecognitionLabels } from '../../../lib/labelExport/labelStore';
import { unconfirmedMachineFields } from '../../../lib/review/settlement';

export async function POST(req: Request) {
  try {
    const { jobId, students: rawStudents, index: rawIndex } = await req.json();

    if (!jobId || !Array.isArray(rawStudents) || rawStudents.length === 0) {
      return NextResponse.json({ error: '필수 파라미터가 누락되었습니다.' }, { status: 400 });
    }

    const students: StudentData[] = rawStudents;
    // Re-saving a student the reviewer has gone back to must land on the row
    // that student already owns. Without an index the only thing this route
    // could do was treat every save as a new last row, so a correction became
    // a duplicate and every later student shifted down a line.
    const newIndex = typeof rawIndex === 'number' ? rawIndex : students.length - 1;
    if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= students.length) {
      return NextResponse.json({ error: '저장 위치가 올바르지 않습니다.' }, { status: 400 });
    }
    const newStudent = students[newIndex];
    const unconfirmedFields = unconfirmedMachineFields(newStudent);
    if (unconfirmedFields.length > 0) {
      return NextResponse.json({
        error: `확인되지 않은 자동 입력은 저장할 수 없습니다. 확인이 필요한 필드: ${unconfirmedFields.join(', ')}`,
        fields: unconfirmedFields,
      }, { status: 400 });
    }

    // 1. 새로 저장하려는 학생 데이터 유효성 검증
    const validation = validateStudent(newStudent);
    if (!validation.ok) {
      return NextResponse.json({
        error: '데이터 검증에 실패했습니다.',
        errors: validation.errors
      }, { status: 400 });
    }

    // 정규화된 값을 명시적으로 반영
    newStudent.basic.gender = normalizeGender(newStudent.basic.gender);
    newStudent.basic.schoolType = normalizeSchoolType(newStudent.basic.schoolType);
    newStudent.basic.grade = normalizeGrade(newStudent.basic.grade);
    newStudent.basic.age = normalizeAge(newStudent.basic.age);

    const targetRow = 3 + newIndex;
    // Return only the persistence contract, never the review draft. Spreading
    // the draft put its preview thumbnails and 23 crop images -- about 1.6MB
    // per student -- into the saved list, the client kept that list and resent
    // it whole on the next save, and the seventh student pushed the request
    // past the platform's body limit. See
    // Task/STUDENT_SAVE_PAYLOAD_GROWTH_AND_NON_JSON_RESPONSE_2026-08-12.md.
    const recognitionValueSource = newStudent.source?.recognitionValueSource;
    const hasRecognitionValueSource = Boolean(
      recognitionValueSource
      && typeof recognitionValueSource === 'object'
      && !Array.isArray(recognitionValueSource),
    );
    const savedStudent: StudentData = {
      studentIndex: targetRow,
      source: {
        cagiImageId: newStudent.source?.cagiImageId,
        satisfactionImageId: newStudent.source?.satisfactionImageId,
        ...(hasRecognitionValueSource ? { recognitionValueSource } : {}),
      },
      basic: newStudent.basic,
      cagi: newStudent.cagi,
      satisfaction: newStudent.satisfaction,
      status: hasRecognitionValueSource ? 'confirmed' : 'saved',
    };
    students[newIndex] = savedStudent;

    // 2. 원본 템플릿에서 학생 목록 전체를 다시 써서 엑셀 2개를 새로 만든다
    //    (이전 요청이 만든 작업 파일이 이 서버리스 인스턴스에 없어도 항상 동작한다)
    const { verifyResult } = await generateWorkbookPair(students);

    if (!verifyResult.ok) {
      return NextResponse.json({
        error: '엑셀 생성 후 무결성 검증 실패',
        errors: verifyResult.errors.map(msg => ({ code: 'INTEGRITY_ERROR', message: msg }))
      }, { status: 500 });
    }

    if (newStudent.source?.cagiImageId) {
      await appendRecognitionLabels({
        jobId,
        studentIndex: newIndex,
        cagiImageId: newStudent.source.cagiImageId,
        student: newStudent,
      });
    }

    return NextResponse.json({
      ok: true,
      row: targetRow,
      student: savedStudent
    });

  } catch (err: any) {
    return NextResponse.json(
      { error: `학생 저장 처리 실패: ${err.message}` },
      { status: 500 }
    );
  }
}
