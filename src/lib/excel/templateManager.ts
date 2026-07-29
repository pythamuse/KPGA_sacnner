import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';

const TEMPLATE_DIR = path.resolve(process.cwd(), 'templates');
const JOBS_DIR = path.join(os.tmpdir(), 'kpga-sacnner', 'jobs');

export interface JobFiles {
  cagiPath: string;
  satisfactionPath: string;
}

export function getTemplateFiles(): JobFiles {
  return {
    cagiPath: findTemplateWorkbook(path.join(TEMPLATE_DIR, 'cagi')),
    satisfactionPath: findTemplateWorkbook(path.join(TEMPLATE_DIR, 'satisfaction')),
  };
}

export function getJobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

export function getJobFiles(jobId: string): JobFiles {
  const jobDir = getJobDir(jobId);
  const templates = getTemplateFiles();

  return {
    cagiPath: path.join(jobDir, path.basename(templates.cagiPath)),
    satisfactionPath: path.join(jobDir, path.basename(templates.satisfactionPath)),
  };
}

export function initJobWorkspace(jobId: string): JobFiles {
  const jobDir = getJobDir(jobId);

  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  const templates = getTemplateFiles();
  const files = getJobFiles(jobId);

  fs.copyFileSync(templates.cagiPath, files.cagiPath);
  fs.copyFileSync(templates.satisfactionPath, files.satisfactionPath);

  return files;
}

export async function loadJobWorkbooks(jobId: string) {
  const files = getJobFiles(jobId);

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

export function restoreExtLst(origPath: string, destPath: string) {
  if (!fs.existsSync(origPath) || !fs.existsSync(destPath)) {
    throw new Error('복원 대상 엑셀 파일이 존재하지 않습니다.');
  }

  const origZip = new AdmZip(origPath);
  const origXml = origZip.readAsText('xl/worksheets/sheet1.xml');
  const extLstMatch = origXml.match(/<extLst>[\s\S]*?<\/extLst>/);

  if (!extLstMatch) {
    return;
  }

  const extLstXml = extLstMatch[0];
  const destZip = new AdmZip(destPath);
  let destXml = destZip.readAsText('xl/worksheets/sheet1.xml');

  destXml = destXml.replace(/<extLst>[\s\S]*?<\/extLst>/g, '');

  const insertIndex = destXml.lastIndexOf('</worksheet>');
  if (insertIndex === -1) {
    throw new Error('저장된 엑셀 파일의 sheet1.xml 구조가 올바르지 않습니다.');
  }

  destXml = destXml.slice(0, insertIndex) + extLstXml + destXml.slice(insertIndex);

  destZip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(destXml, 'utf-8'));
  destZip.writeZip(destPath);
}

export function backupJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(files.cagiPath)) {
    fs.copyFileSync(files.cagiPath, `${files.cagiPath}.bak`);
  }
  if (fs.existsSync(files.satisfactionPath)) {
    fs.copyFileSync(files.satisfactionPath, `${files.satisfactionPath}.bak`);
  }
}

export function rollbackJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.renameSync(`${files.cagiPath}.bak`, files.cagiPath);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.renameSync(`${files.satisfactionPath}.bak`, files.satisfactionPath);
  }
}

export function commitJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.unlinkSync(`${files.cagiPath}.bak`);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.unlinkSync(`${files.satisfactionPath}.bak`);
  }
}

function findTemplateWorkbook(templateDir: string): string {
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }

  const workbook = fs.readdirSync(templateDir).find((filename) => filename.toLowerCase().endsWith('.xlsx'));
  if (!workbook) {
    throw new Error(`Template workbook not found in: ${templateDir}`);
  }

  return path.join(templateDir, workbook);
}
