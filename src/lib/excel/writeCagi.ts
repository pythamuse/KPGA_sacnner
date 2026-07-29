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
