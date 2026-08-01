import ExcelJS from 'exceljs';
import { StudentData } from '../validation/types';

export function writeCagiRow(sheet: ExcelJS.Worksheet, row: number, student: StudentData) {
  const basic = student.basic;
  const cagi = student.cagi;

  // A~D 기본 정보
  sheet.getCell(`A${row}`).value = Number(basic.age);
  sheet.getCell(`B${row}`).value = basic.gender;
  sheet.getCell(`C${row}`).value = basic.schoolType;
  sheet.getCell(`D${row}`).value = basic.grade;

  // E~M 문항
  sheet.getCell(`E${row}`).value = Number(cagi.q01);
  sheet.getCell(`F${row}`).value = Number(cagi.q02);
  sheet.getCell(`G${row}`).value = Number(cagi.q03);
  sheet.getCell(`H${row}`).value = Number(cagi.q04);
  sheet.getCell(`I${row}`).value = Number(cagi.q05);
  sheet.getCell(`J${row}`).value = Number(cagi.q06);
  sheet.getCell(`K${row}`).value = Number(cagi.q07);
  sheet.getCell(`L${row}`).value = Number(cagi.q08);
  sheet.getCell(`M${row}`).value = Number(cagi.q09);
}

/**
 * 성인 CPGI 템플릿(양식_성인도박문제선별검사_CPGI.xlsx)은 학교유형·학년 컬럼이
 * 없다. A=연령대, B=성별, C~K=CPGI 01~09 순서로 한 칸씩 앞당겨 쓴다.
 */
export function writeCpgiRow(sheet: ExcelJS.Worksheet, row: number, student: StudentData) {
  const basic = student.basic;
  const cagi = student.cagi;

  sheet.getCell(`A${row}`).value = Number(basic.age);
  sheet.getCell(`B${row}`).value = basic.gender;

  sheet.getCell(`C${row}`).value = Number(cagi.q01);
  sheet.getCell(`D${row}`).value = Number(cagi.q02);
  sheet.getCell(`E${row}`).value = Number(cagi.q03);
  sheet.getCell(`F${row}`).value = Number(cagi.q04);
  sheet.getCell(`G${row}`).value = Number(cagi.q05);
  sheet.getCell(`H${row}`).value = Number(cagi.q06);
  sheet.getCell(`I${row}`).value = Number(cagi.q07);
  sheet.getCell(`J${row}`).value = Number(cagi.q08);
  sheet.getCell(`K${row}`).value = Number(cagi.q09);
}
