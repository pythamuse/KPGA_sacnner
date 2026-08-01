import ExcelJS from 'exceljs';
import { StudentData } from '../validation/types';

export function writeSatisfactionRow(sheet: ExcelJS.Worksheet, row: number, student: StudentData) {
  const basic = student.basic;
  const satisfaction = student.satisfaction;

  // A~D 기본 정보 (선별검사지에서 복사)
  sheet.getCell(`A${row}`).value = Number(basic.age);
  sheet.getCell(`B${row}`).value = basic.gender;
  sheet.getCell(`C${row}`).value = basic.schoolType;
  sheet.getCell(`D${row}`).value = basic.grade;

  // E~N 문항
  sheet.getCell(`E${row}`).value = Number(satisfaction.q01);
  sheet.getCell(`F${row}`).value = Number(satisfaction.q02);
  sheet.getCell(`G${row}`).value = Number(satisfaction.q03);
  sheet.getCell(`H${row}`).value = Number(satisfaction.q04);
  sheet.getCell(`I${row}`).value = Number(satisfaction.q05);
  sheet.getCell(`J${row}`).value = Number(satisfaction.q06);
  sheet.getCell(`K${row}`).value = Number(satisfaction.q07);
  sheet.getCell(`L${row}`).value = Number(satisfaction.q08);
  sheet.getCell(`M${row}`).value = Number(satisfaction.q09);
  sheet.getCell(`N${row}`).value = Number(satisfaction.q10);
}

/**
 * 성인 만족도 템플릿(성인예방교육만족도.xlsx)은 학교유형·학년 컬럼이 없다.
 * A=연령대, B=성별, C~L=문항1~10 순서로 두 칸씩 앞당겨 쓴다.
 */
export function writeAdultSatisfactionRow(sheet: ExcelJS.Worksheet, row: number, student: StudentData) {
  const basic = student.basic;
  const satisfaction = student.satisfaction;

  sheet.getCell(`A${row}`).value = Number(basic.age);
  sheet.getCell(`B${row}`).value = basic.gender;

  sheet.getCell(`C${row}`).value = Number(satisfaction.q01);
  sheet.getCell(`D${row}`).value = Number(satisfaction.q02);
  sheet.getCell(`E${row}`).value = Number(satisfaction.q03);
  sheet.getCell(`F${row}`).value = Number(satisfaction.q04);
  sheet.getCell(`G${row}`).value = Number(satisfaction.q05);
  sheet.getCell(`H${row}`).value = Number(satisfaction.q06);
  sheet.getCell(`I${row}`).value = Number(satisfaction.q07);
  sheet.getCell(`J${row}`).value = Number(satisfaction.q08);
  sheet.getCell(`K${row}`).value = Number(satisfaction.q09);
  sheet.getCell(`L${row}`).value = Number(satisfaction.q10);
}
