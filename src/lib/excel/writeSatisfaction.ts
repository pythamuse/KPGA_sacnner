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
