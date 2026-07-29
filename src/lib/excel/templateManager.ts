import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const TEMPLATE_DIR = path.resolve(process.cwd(), 'templates');
const JOBS_DIR = path.resolve(process.cwd(), 'tmp', 'jobs');

export interface JobFiles {
  cagiPath: string;
  satisfactionPath: string;
}

export function getJobDir(jobId: string): string {
  return path.join(JOBS_DIR, jobId);
}

export function getJobFiles(jobId: string): JobFiles {
  const jobDir = getJobDir(jobId);
  return {
    cagiPath: path.join(jobDir, '양식_청소년도박문제선별검사_CAGI_3.xlsx'),
    satisfactionPath: path.join(jobDir, '청소년예방교육만족도.xlsx')
  };
}

/**
 * 새로운 작업 세션을 초기화하고 템플릿 파일을 복사합니다.
 */
export function initJobWorkspace(jobId: string): JobFiles {
  const jobDir = getJobDir(jobId);
  
  // 디렉토리 생성
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  const origCagi = path.join(TEMPLATE_DIR, 'cagi', '양식_청소년도박문제선별검사_CAGI_3.xlsx');
  const origSat = path.join(TEMPLATE_DIR, 'satisfaction', '청소년예방교육만족도.xlsx');

  const files = getJobFiles(jobId);

  // 원본이 없으면 에러
  if (!fs.existsSync(origCagi) || !fs.existsSync(origSat)) {
    throw new Error('원본 엑셀 템플릿 파일을 찾을 수 없습니다.');
  }

  // 복사
  fs.copyFileSync(origCagi, files.cagiPath);
  fs.copyFileSync(origSat, files.satisfactionPath);

  return files;
}

/**
 * 특정 작업의 복사된 엑셀 파일들을 ExcelJS 워크북 객체로 로드합니다.
 */
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
    satisfactionPath: files.satisfactionPath
  };
}

/**
 * 원본 템플릿의 xl/worksheets/sheet1.xml 에서 extLst 블록을 추출하여 저장된 파일에 복원합니다.
 * ExcelJS가 저장하는 과정에서 제거하는 x14:dataValidations 를 복원하기 위한 장치입니다.
 */
import AdmZip from 'adm-zip';

export function restoreExtLst(origPath: string, destPath: string) {
  if (!fs.existsSync(origPath) || !fs.existsSync(destPath)) {
    throw new Error('복원 대상 엑셀 파일이 존재하지 않습니다.');
  }

  // 1. 원본 파일에서 extLst 추출
  const origZip = new AdmZip(origPath);
  const origXml = origZip.readAsText('xl/worksheets/sheet1.xml');
  const extLstMatch = origXml.match(/<extLst>[\s\S]*?<\/extLst>/);

  if (!extLstMatch) {
    // 원본에 extLst가 없다면 복원할 필요 없음
    return;
  }

  const extLstXml = extLstMatch[0];

  // 2. 대상 파일에 extLst 삽입
  const destZip = new AdmZip(destPath);
  let destXml = destZip.readAsText('xl/worksheets/sheet1.xml');

  // 기존에 extLst가 이미 존재한다면 제거 (혹시 몰라 처리)
  destXml = destXml.replace(/<extLst>[\s\S]*?<\/extLst>/g, '');

  // worksheet 닫기 태그 </worksheet> 직전에 삽입
  const insertIndex = destXml.lastIndexOf('</worksheet>');
  if (insertIndex === -1) {
    throw new Error('대상 엑셀 파일의 sheet1.xml 구조가 올바르지 않습니다 (</worksheet> 없음).');
  }

  destXml = destXml.slice(0, insertIndex) + extLstXml + destXml.slice(insertIndex);

  // 3. zip에 반영 후 저장
  destZip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(destXml, 'utf-8'));
  destZip.writeZip(destPath);
}

/**
 * 트랜잭션 오류 처리를 위해 현재 작업 파일을 백업합니다.
 */
export function backupJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(files.cagiPath)) {
    fs.copyFileSync(files.cagiPath, `${files.cagiPath}.bak`);
  }
  if (fs.existsSync(files.satisfactionPath)) {
    fs.copyFileSync(files.satisfactionPath, `${files.satisfactionPath}.bak`);
  }
}

/**
 * 트랜잭션 실패 시 백업된 파일로 롤백합니다.
 */
export function rollbackJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.renameSync(`${files.cagiPath}.bak`, files.cagiPath);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.renameSync(`${files.satisfactionPath}.bak`, files.satisfactionPath);
  }
}

/**
 * 트랜잭션 성공 시 백업 파일을 제거합니다.
 */
export function commitJobFiles(jobId: string) {
  const files = getJobFiles(jobId);
  if (fs.existsSync(`${files.cagiPath}.bak`)) {
    fs.unlinkSync(`${files.cagiPath}.bak`);
  }
  if (fs.existsSync(`${files.satisfactionPath}.bak`)) {
    fs.unlinkSync(`${files.satisfactionPath}.bak`);
  }
}


