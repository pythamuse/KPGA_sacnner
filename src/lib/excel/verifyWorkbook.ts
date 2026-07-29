import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { StudentData } from '../validation/types';
import { validateStudent } from '../validation/validateStudent';

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export async function verifyWorkbooks(
  cagiPath: string,
  satisfactionPath: string,
  expectedStudents: StudentData[]
): Promise<VerifyResult> {
  const errors: string[] = [];

  try {
    const cagiWorkbook = new ExcelJS.Workbook();
    await cagiWorkbook.xlsx.readFile(cagiPath);

    const satWorkbook = new ExcelJS.Workbook();
    await satWorkbook.xlsx.readFile(satisfactionPath);

    // 1. 시트 존재 확인
    const cagiSheet = cagiWorkbook.getWorksheet('청소년도박문제선별검사');
    if (!cagiSheet) {
      errors.push('CAGI 엑셀 파일에 "청소년도박문제선별검사" 시트가 존재하지 않습니다.');
    }

    const satSheet = satWorkbook.getWorksheet('청소년예방교육만족도');
    if (!satSheet) {
      errors.push('만족도 엑셀 파일에 "청소년예방교육만족도" 시트가 존재하지 않습니다.');
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

      // CAGI 값 읽기
      const cagiAge = cagiSheetNonNull.getCell(`A${row}`).value;
      const cagiGender = cagiSheetNonNull.getCell(`B${row}`).value;
      const cagiSchool = cagiSheetNonNull.getCell(`C${row}`).value;
      const cagiGrade = cagiSheetNonNull.getCell(`D${row}`).value;

      const cagiQ01 = cagiSheetNonNull.getCell(`E${row}`).value;
      const cagiQ02 = cagiSheetNonNull.getCell(`F${row}`).value;
      const cagiQ03 = cagiSheetNonNull.getCell(`G${row}`).value;
      const cagiQ04 = cagiSheetNonNull.getCell(`H${row}`).value;
      const cagiQ05 = cagiSheetNonNull.getCell(`I${row}`).value;
      const cagiQ06 = cagiSheetNonNull.getCell(`J${row}`).value;
      const cagiQ07 = cagiSheetNonNull.getCell(`K${row}`).value;
      const cagiQ08 = cagiSheetNonNull.getCell(`L${row}`).value;
      const cagiQ09 = cagiSheetNonNull.getCell(`M${row}`).value;

      // 만족도 값 읽기
      const satAge = satSheetNonNull.getCell(`A${row}`).value;
      const satGender = satSheetNonNull.getCell(`B${row}`).value;
      const satSchool = satSheetNonNull.getCell(`C${row}`).value;
      const satGrade = satSheetNonNull.getCell(`D${row}`).value;

      const satQ01 = satSheetNonNull.getCell(`E${row}`).value;
      const satQ02 = satSheetNonNull.getCell(`F${row}`).value;
      const satQ03 = satSheetNonNull.getCell(`G${row}`).value;
      const satQ04 = satSheetNonNull.getCell(`H${row}`).value;
      const satQ05 = satSheetNonNull.getCell(`I${row}`).value;
      const satQ06 = satSheetNonNull.getCell(`J${row}`).value;
      const satQ07 = satSheetNonNull.getCell(`K${row}`).value;
      const satQ08 = satSheetNonNull.getCell(`L${row}`).value;
      const satQ09 = satSheetNonNull.getCell(`M${row}`).value;
      const satQ10 = satSheetNonNull.getCell(`N${row}`).value;

      // 값 일치 검사
      if (Number(cagiAge) !== Number(student.basic.age)) errors.push(`행 ${row}: CAGI 나이 불일치. 기대값 ${student.basic.age}, 실제값 ${cagiAge}`);
      if (String(cagiGender) !== String(student.basic.gender)) errors.push(`행 ${row}: CAGI 성별 불일치. 기대값 ${student.basic.gender}, 실제값 ${cagiGender}`);
      if (String(cagiSchool) !== String(student.basic.schoolType)) errors.push(`행 ${row}: CAGI 학교유형 불일치. 기대값 ${student.basic.schoolType}, 실제값 ${cagiSchool}`);
      if (String(cagiGrade) !== String(student.basic.grade)) errors.push(`행 ${row}: CAGI 학년 불일치. 기대값 ${student.basic.grade}, 실제값 ${cagiGrade}`);

      if (Number(cagiQ01) !== Number(student.cagi.q01)) errors.push(`행 ${row}: CAGI q01 불일치. 기대값 ${student.cagi.q01}, 실제값 ${cagiQ01}`);
      if (Number(cagiQ02) !== Number(student.cagi.q02)) errors.push(`행 ${row}: CAGI q02 불일치. 기대값 ${student.cagi.q02}, 실제값 ${cagiQ02}`);
      if (Number(cagiQ03) !== Number(student.cagi.q03)) errors.push(`행 ${row}: CAGI q03 불일치. 기대값 ${student.cagi.q03}, 실제값 ${cagiQ03}`);
      if (Number(cagiQ04) !== Number(student.cagi.q04)) errors.push(`행 ${row}: CAGI q04 불일치. 기대값 ${student.cagi.q04}, 실제값 ${cagiQ04}`);
      if (Number(cagiQ05) !== Number(student.cagi.q05)) errors.push(`행 ${row}: CAGI q05 불일치. 기대값 ${student.cagi.q05}, 실제값 ${cagiQ05}`);
      if (Number(cagiQ06) !== Number(student.cagi.q06)) errors.push(`행 ${row}: CAGI q06 불일치. 기대값 ${student.cagi.q06}, 실제값 ${cagiQ06}`);
      if (Number(cagiQ07) !== Number(student.cagi.q07)) errors.push(`행 ${row}: CAGI q07 불일치. 기대값 ${student.cagi.q07}, 실제값 ${cagiQ07}`);
      if (Number(cagiQ08) !== Number(student.cagi.q08)) errors.push(`행 ${row}: CAGI q08 불일치. 기대값 ${student.cagi.q08}, 실제값 ${cagiQ08}`);
      if (Number(cagiQ09) !== Number(student.cagi.q09)) errors.push(`행 ${row}: CAGI q09 불일치. 기대값 ${student.cagi.q09}, 실제값 ${cagiQ09}`);

      if (Number(satAge) !== Number(student.basic.age)) errors.push(`행 ${row}: 만족도 나이 불일치. 기대값 ${student.basic.age}, 실제값 ${satAge}`);
      if (String(satGender) !== String(student.basic.gender)) errors.push(`행 ${row}: 만족도 성별 불일치. 기대값 ${student.basic.gender}, 실제값 ${satGender}`);
      if (String(satSchool) !== String(student.basic.schoolType)) errors.push(`행 ${row}: 만족도 학교유형 불일치. 기대값 ${student.basic.schoolType}, 실제값 ${satSchool}`);
      if (String(satGrade) !== String(student.basic.grade)) errors.push(`행 ${row}: 만족도 학년 불일치. 기대값 ${student.basic.grade}, 실제값 ${satGrade}`);

      if (Number(satQ01) !== Number(student.satisfaction.q01)) errors.push(`행 ${row}: 만족도 q01 불일치. 기대값 ${student.satisfaction.q01}, 실제값 ${satQ01}`);
      if (Number(satQ02) !== Number(student.satisfaction.q02)) errors.push(`행 ${row}: 만족도 q02 불일치. 기대값 ${student.satisfaction.q02}, 실제값 ${satQ02}`);
      if (Number(satQ03) !== Number(student.satisfaction.q03)) errors.push(`행 ${row}: 만족도 q03 불일치. 기대값 ${student.satisfaction.q03}, 실제값 ${satQ03}`);
      if (Number(satQ04) !== Number(student.satisfaction.q04)) errors.push(`행 ${row}: 만족도 q04 불일치. 기대값 ${student.satisfaction.q04}, 실제값 ${satQ04}`);
      if (Number(satQ05) !== Number(student.satisfaction.q05)) errors.push(`행 ${row}: 만족도 q05 불일치. 기대값 ${student.satisfaction.q05}, 실제값 ${satQ05}`);
      if (Number(satQ06) !== Number(student.satisfaction.q06)) errors.push(`행 ${row}: 만족도 q06 불일치. 기대값 ${student.satisfaction.q06}, 실제값 ${satQ06}`);
      if (Number(satQ07) !== Number(student.satisfaction.q07)) errors.push(`행 ${row}: 만족도 q07 불일치. 기대값 ${student.satisfaction.q07}, 실제값 ${satQ07}`);
      if (Number(satQ08) !== Number(student.satisfaction.q08)) errors.push(`행 ${row}: 만족도 q08 불일치. 기대값 ${student.satisfaction.q08}, 실제값 ${satQ08}`);
      if (Number(satQ09) !== Number(student.satisfaction.q09)) errors.push(`행 ${row}: 만족도 q09 불일치. 기대값 ${student.satisfaction.q09}, 실제값 ${satQ09}`);
      if (Number(satQ10) !== Number(student.satisfaction.q10)) errors.push(`행 ${row}: 만족도 q10 불일치. 기대값 ${student.satisfaction.q10}, 실제값 ${satQ10}`);

      // 드롭다운 보존 검증 (XML 수준에서 x14:dataValidations 검사)
      // ExcelJS는 x14 유효성 검사를 날려버리기 때문에 저장 후 복원 처리가 완료되었는지 검사한다.
      const checkDropdowns = (filePath: string, label: string) => {
        try {
          const zip = new AdmZip(filePath);
          const xml = zip.readAsText('xl/worksheets/sheet1.xml');
          if (!xml.includes('x14:dataValidations')) {
            errors.push(`${label} 엑셀 파일에 데이터 유효성 검사(드롭다운, x14:dataValidations)가 유실되었습니다.`);
          }
        } catch (err: any) {
          errors.push(`${label} 엑셀 파일 압축 해제 검증 중 오류: ${err.message}`);
        }
      };
      
      if (i === 0) { // 파일당 1번만 검사하면 됨
        checkDropdowns(cagiPath, 'CAGI');
        checkDropdowns(satisfactionPath, '만족도');
      }
    }

    // 다음 행이 비어있는지 확인
    const nextRow = 3 + expectedCount;
    const cagiNextValue = cagiSheetNonNull.getCell(`A${nextRow}`).value;
    if (cagiNextValue !== null && cagiNextValue !== undefined && cagiNextValue !== '') {
      errors.push(`행 ${nextRow}: CAGI 파일에 기대되지 않은 데이터가 존재합니다.`);
    }

    const satNextValue = satSheetNonNull.getCell(`A${nextRow}`).value;
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
