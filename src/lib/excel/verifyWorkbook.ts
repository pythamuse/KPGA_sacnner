import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { StudentData } from '../validation/types';
import { FormTrack } from './templateManager';

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

interface TrackLayout {
  sheetName: string;
  age: string;
  gender: string;
  schoolType?: string;
  grade?: string;
  questionColumns: string[];
  questionLabel: string;
}

const CAGI_LAYOUTS: Record<FormTrack, TrackLayout> = {
  youth: {
    sheetName: '청소년도박문제선별검사',
    age: 'A', gender: 'B', schoolType: 'C', grade: 'D',
    questionColumns: ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
    questionLabel: 'CAGI',
  },
  adult: {
    sheetName: '성인도박문제선별검사',
    age: 'A', gender: 'B',
    questionColumns: ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'],
    questionLabel: 'CPGI',
  },
};

const SATISFACTION_LAYOUTS: Record<FormTrack, TrackLayout> = {
  youth: {
    sheetName: '청소년예방교육만족도',
    age: 'A', gender: 'B', schoolType: 'C', grade: 'D',
    questionColumns: ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'],
    questionLabel: '만족도',
  },
  adult: {
    sheetName: '성인예방교육만족도',
    age: 'A', gender: 'B',
    questionColumns: ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
    questionLabel: '만족도',
  },
};

export async function verifyWorkbooks(
  cagiPath: string,
  satisfactionPath: string,
  expectedStudents: StudentData[],
  track: FormTrack = 'youth'
): Promise<VerifyResult> {
  const errors: string[] = [];
  const cagiLayout = CAGI_LAYOUTS[track];
  const satLayout = SATISFACTION_LAYOUTS[track];

  try {
    const cagiWorkbook = new ExcelJS.Workbook();
    await cagiWorkbook.xlsx.readFile(cagiPath);

    const satWorkbook = new ExcelJS.Workbook();
    await satWorkbook.xlsx.readFile(satisfactionPath);

    // 1. 시트 존재 확인
    const cagiSheet = cagiWorkbook.getWorksheet(cagiLayout.sheetName);
    if (!cagiSheet) {
      errors.push(`CAGI 엑셀 파일에 "${cagiLayout.sheetName}" 시트가 존재하지 않습니다.`);
    }

    const satSheet = satWorkbook.getWorksheet(satLayout.sheetName);
    if (!satSheet) {
      errors.push(`만족도 엑셀 파일에 "${satLayout.sheetName}" 시트가 존재하지 않습니다.`);
    }

    // 코드 시트 존재 확인
    if (!cagiWorkbook.getWorksheet('코드')) {
      errors.push('CAGI 엑셀 파일에 "코드" 시트가 소실되었습니다.');
    }
    if (!satWorkbook.getWorksheet('코드')) {
      errors.push('만족도 엑셀 파일에 "코드" 시트가 소실되었습니다.');
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    const cagiSheetNonNull = cagiSheet!;
    const satSheetNonNull = satSheet!;

    // 2. 행 데이터 검증 및 행 번호 일치 확인
    const expectedCount = expectedStudents.length;
    for (let i = 0; i < expectedCount; i++) {
      const student = expectedStudents[i];
      const row = 3 + i;

      checkBasicInfo(cagiSheetNonNull, cagiLayout, row, student, 'CAGI', errors);
      checkQuestions(cagiSheetNonNull, cagiLayout, row, student.cagi, errors);

      checkBasicInfo(satSheetNonNull, satLayout, row, student, '만족도', errors);
      checkQuestions(satSheetNonNull, satLayout, row, student.satisfaction, errors);

      // 드롭다운 보존 검증 (XML 수준에서 x14:dataValidations 검사)
      // ExcelJS는 x14 유효성 검사를 날려버리기 때문에 저장 후 복원 처리가 완료되었는지 검사한다.
      if (i === 0) { // 파일당 1번만 검사하면 됨
        checkDropdowns(cagiPath, 'CAGI', cagiLayout.sheetName, errors);
        checkDropdowns(satisfactionPath, '만족도', satLayout.sheetName, errors);
      }
    }

    // 다음 행이 비어있는지 확인
    const nextRow = 3 + expectedCount;
    const cagiNextValue = cagiSheetNonNull.getCell(`${cagiLayout.age}${nextRow}`).value;
    if (cagiNextValue !== null && cagiNextValue !== undefined && cagiNextValue !== '') {
      errors.push(`행 ${nextRow}: CAGI 파일에 기대되지 않은 데이터가 존재합니다.`);
    }

    const satNextValue = satSheetNonNull.getCell(`${satLayout.age}${nextRow}`).value;
    if (satNextValue !== null && satNextValue !== undefined && satNextValue !== '') {
      errors.push(`행 ${nextRow}: 만족도 파일에 기대되지 않은 데이터가 존재합니다.`);
    }

  } catch (err: any) {
    errors.push(`엑셀 검증 중 치명적인 예외가 발생했습니다: ${err.message}`);
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function checkBasicInfo(
  sheet: ExcelJS.Worksheet,
  layout: TrackLayout,
  row: number,
  student: StudentData,
  label: string,
  errors: string[]
) {
  const age = sheet.getCell(`${layout.age}${row}`).value;
  const gender = sheet.getCell(`${layout.gender}${row}`).value;

  if (Number(age) !== Number(student.basic.age)) errors.push(`행 ${row}: ${label} 나이 불일치. 기대값 ${student.basic.age}, 실제값 ${age}`);
  if (String(gender) !== String(student.basic.gender)) errors.push(`행 ${row}: ${label} 성별 불일치. 기대값 ${student.basic.gender}, 실제값 ${gender}`);

  if (layout.schoolType) {
    const schoolType = sheet.getCell(`${layout.schoolType}${row}`).value;
    if (String(schoolType) !== String(student.basic.schoolType)) errors.push(`행 ${row}: ${label} 학교유형 불일치. 기대값 ${student.basic.schoolType}, 실제값 ${schoolType}`);
  }

  if (layout.grade) {
    const grade = sheet.getCell(`${layout.grade}${row}`).value;
    if (String(grade) !== String(student.basic.grade)) errors.push(`행 ${row}: ${label} 학년 불일치. 기대값 ${student.basic.grade}, 실제값 ${grade}`);
  }
}

function checkQuestions(
  sheet: ExcelJS.Worksheet,
  layout: TrackLayout,
  row: number,
  answers: Record<string, number | undefined>,
  errors: string[]
) {
  layout.questionColumns.forEach((col, idx) => {
    const key = `q${String(idx + 1).padStart(2, '0')}`;
    const actual = sheet.getCell(`${col}${row}`).value;
    const expected = answers[key];
    if (Number(actual) !== Number(expected)) {
      errors.push(`행 ${row}: ${layout.questionLabel} ${key} 불일치. 기대값 ${expected}, 실제값 ${actual}`);
    }
  });
}

function checkDropdowns(filePath: string, label: string, sheetName: string, errors: string[]) {
  try {
    const zip = new AdmZip(filePath);
    const sheetXmlPath = resolveWorksheetXmlPath(zip, sheetName);
    const xml = zip.readAsText(sheetXmlPath);
    if (!xml.includes('x14:dataValidations')) {
      errors.push(`${label} 엑셀 파일에 데이터 유효성 검사(드롭다운, x14:dataValidations)가 유실되었습니다.`);
    }
  } catch (err: any) {
    errors.push(`${label} 엑셀 파일 압축 해제 검증 중 오류: ${err.message}`);
  }
}

function resolveWorksheetXmlPath(zip: AdmZip, sheetName: string): string {
  const workbookXml = zip.readAsText('xl/workbook.xml');
  const sheetTagMatch = workbookXml.match(
    new RegExp(`<sheet [^>]*name="${escapeRegExp(sheetName)}"[^>]*/>`)
  );
  if (!sheetTagMatch) {
    return 'xl/worksheets/sheet1.xml';
  }

  const rIdMatch = sheetTagMatch[0].match(/r:id="([^"]+)"/);
  if (!rIdMatch) {
    return 'xl/worksheets/sheet1.xml';
  }

  const relsXml = zip.readAsText('xl/_rels/workbook.xml.rels');
  const relTagMatch = relsXml.match(new RegExp(`<Relationship [^>]*Id="${rIdMatch[1]}"[^>]*/>`));
  const targetMatch = relTagMatch?.[0].match(/Target="([^"]+)"/);

  return targetMatch ? `xl/${targetMatch[1]}` : 'xl/worksheets/sheet1.xml';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
