import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import { FormTrack } from '../validation/types';

export type { FormTrack } from '../validation/types';

const TEMPLATE_DIR = path.resolve(process.cwd(), 'templates');
const JOBS_DIR = path.join(os.tmpdir(), 'kpga-sacnner', 'jobs');

export interface JobFiles {
  cagiPath: string;
  satisfactionPath: string;
}

// 디렉터리 안의 첫 .xlsx를 아무거나 집는 방식은 같은 폴더에 참고용 파일이 하나만 추가돼도
// 엉뚱한 템플릿을 골라버리는 사고로 이어진다. 반드시 트랙별 정확한 파일명으로 찾는다.
const TEMPLATE_FILENAMES: Record<FormTrack, JobFiles> = {
  youth: {
    cagiPath: '양식_청소년도박문제선별검사_CAGI_3.xlsx',
    satisfactionPath: '청소년예방교육만족도.xlsx',
  },
  adult: {
    cagiPath: '양식_성인도박문제선별검사_CPGI.xlsx',
    satisfactionPath: '성인예방교육만족도.xlsx',
  },
};

export function getTemplateFiles(track: FormTrack = 'youth'): JobFiles {
  const filenames = TEMPLATE_FILENAMES[track];
  return {
    cagiPath: resolveTemplateWorkbook(path.join(TEMPLATE_DIR, 'cagi'), filenames.cagiPath),
    satisfactionPath: resolveTemplateWorkbook(path.join(TEMPLATE_DIR, 'satisfaction'), filenames.satisfactionPath),
  };
}

export function getJobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

export function getJobFiles(jobId: string, track: FormTrack = 'youth'): JobFiles {
  const jobDir = getJobDir(jobId);
  const templates = getTemplateFiles(track);

  return {
    cagiPath: path.join(jobDir, path.basename(templates.cagiPath)),
    satisfactionPath: path.join(jobDir, path.basename(templates.satisfactionPath)),
  };
}

export function initJobWorkspace(jobId: string, track: FormTrack = 'youth'): JobFiles {
  const jobDir = getJobDir(jobId);

  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  const templates = getTemplateFiles(track);
  const files = getJobFiles(jobId, track);

  fs.copyFileSync(templates.cagiPath, files.cagiPath);
  fs.copyFileSync(templates.satisfactionPath, files.satisfactionPath);

  return files;
}

export async function loadJobWorkbooks(jobId: string, track: FormTrack = 'youth') {
  const files = getJobFiles(jobId, track);

  if (!fs.existsSync(files.cagiPath) || !fs.existsSync(files.satisfactionPath)) {
    throw new Error(`작업 세션 ${jobId}의 파일을 찾을 수 없습니다. 먼저 세션을 생성하세요.`);
  }

  const cagiWorkbook = new ExcelJS.Workbook();
  const satisfactionWorkbook = new ExcelJS.Workbook();

  await cagiWorkbook.xlsx.readFile(files.cagiPath);
  await satisfactionWorkbook.xlsx.readFile(files.satisfactionPath);

  return {
    cagiWorkbook,
    satisfactionWorkbook,
    cagiPath: files.cagiPath,
    satisfactionPath: files.satisfactionPath,
  };
}

/**
 * 입력 시트가 항상 xl/worksheets/sheet1.xml이라는 보장은 없다(내부 rId 순서는
 * 시트 생성 순서를 따르며 화면상 첫 번째 탭과 다를 수 있다). workbook.xml과
 * workbook.xml.rels를 따라가 시트명으로부터 실제 파일명을 찾는다.
 */
function resolveWorksheetXmlPath(zip: AdmZip, sheetName: string): string {
  const workbookXml = zip.readAsText('xl/workbook.xml');
  const sheetTagMatch = workbookXml.match(
    new RegExp(`<sheet [^>]*name="${escapeRegExp(sheetName)}"[^>]*/>`)
  );
  if (!sheetTagMatch) {
    throw new Error(`워크북에서 "${sheetName}" 시트를 찾을 수 없습니다.`);
  }

  const rIdMatch = sheetTagMatch[0].match(/r:id="([^"]+)"/);
  if (!rIdMatch) {
    throw new Error(`"${sheetName}" 시트의 관계 ID(r:id)를 찾을 수 없습니다.`);
  }
  const rId = rIdMatch[1];

  const relsXml = zip.readAsText('xl/_rels/workbook.xml.rels');
  const relTagMatch = relsXml.match(new RegExp(`<Relationship [^>]*Id="${rId}"[^>]*/>`));
  if (!relTagMatch) {
    throw new Error(`관계 정의에서 ${rId}를 찾을 수 없습니다.`);
  }

  const targetMatch = relTagMatch[0].match(/Target="([^"]+)"/);
  if (!targetMatch) {
    throw new Error(`관계 정의 ${rId}에 Target이 없습니다.`);
  }

  return `xl/${targetMatch[1]}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * sheetName을 지정하면 workbook.xml 관계를 따라 정확한 시트 XML을 찾아 처리한다.
 * 지정하지 않으면 기존 동작(청소년 템플릿 기준 sheet1.xml)을 그대로 유지한다.
 */
export function restoreExtLst(origPath: string, destPath: string, sheetName?: string) {
  if (!fs.existsSync(origPath) || !fs.existsSync(destPath)) {
    throw new Error('복원 대상 엑셀 파일이 존재하지 않습니다.');
  }

  const origZip = new AdmZip(origPath);
  const destZip = new AdmZip(destPath);

  const origSheetXmlPath = sheetName ? resolveWorksheetXmlPath(origZip, sheetName) : 'xl/worksheets/sheet1.xml';
  const destSheetXmlPath = sheetName ? resolveWorksheetXmlPath(destZip, sheetName) : 'xl/worksheets/sheet1.xml';

  const origXml = origZip.readAsText(origSheetXmlPath);
  const extLstMatch = origXml.match(/<extLst>[\s\S]*?<\/extLst>/);

  if (!extLstMatch) {
    return;
  }

  const extLstXml = extLstMatch[0];
  let destXml = destZip.readAsText(destSheetXmlPath);

  destXml = destXml.replace(/<extLst>[\s\S]*?<\/extLst>/g, '');

  const insertIndex = destXml.lastIndexOf('</worksheet>');
  if (insertIndex === -1) {
    throw new Error('저장된 엑셀 파일의 시트 구조가 올바르지 않습니다.');
  }

  destXml = destXml.slice(0, insertIndex) + extLstXml + destXml.slice(insertIndex);

  destZip.updateFile(destSheetXmlPath, Buffer.from(destXml, 'utf-8'));
  destZip.writeZip(destPath);
}

export function backupJobFiles(jobId: string, track: FormTrack = 'youth') {
  const files = getJobFiles(jobId, track);
  if (fs.existsSync(files.cagiPath)) {
    fs.copyFileSync(files.cagiPath, `${files.cagiPath}.bak`);
  }
  if (fs.existsSync(files.satisfactionPath)) {
    fs.copyFileSync(files.satisfactionPath, `${files.satisfactionPath}.bak`);
  }
}

export function rollbackJobFiles(jobId: string, track: FormTrack = 'youth') {
  const files = getJobFiles(jobId, track);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.renameSync(`${files.cagiPath}.bak`, files.cagiPath);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.renameSync(`${files.satisfactionPath}.bak`, files.satisfactionPath);
  }
}

export function commitJobFiles(jobId: string, track: FormTrack = 'youth') {
  const files = getJobFiles(jobId, track);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.unlinkSync(`${files.cagiPath}.bak`);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.unlinkSync(`${files.satisfactionPath}.bak`);
  }
}

function resolveTemplateWorkbook(templateDir: string, filename: string): string {
  const fullPath = path.join(templateDir, filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`템플릿 파일을 찾을 수 없습니다: ${fullPath}`);
  }
  return fullPath;
}
