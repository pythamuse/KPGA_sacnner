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

  if (path.resolve(origPath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
    throw new Error('원본 템플릿에는 확장 영역을 복원할 수 없습니다. 작업 파일 사본을 사용하세요.');
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
  destXml = mergeWorksheetRootNamespaces(origXml, destXml);

  const insertIndex = destXml.lastIndexOf('</worksheet>');
  if (insertIndex === -1) {
    throw new Error('저장된 엑셀 파일의 sheet1.xml 구조가 올바르지 않습니다.');
  }

  destXml = destXml.slice(0, insertIndex) + extLstXml + destXml.slice(insertIndex);

  destZip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(destXml, 'utf-8'));
  destZip.writeZip(destPath);
}

/**
 * ExcelJS writes a clean worksheet root, then we restore the template's
 * x14:dataValidations extension. That extension may reference `xr`, `x14`,
 * or `xm` prefixes that only existed on the original worksheet root. Keep the
 * required declarations and the Ignorable token list together with extLst so
 * Excel never has to repair a downloaded workbook.
 */
export function mergeWorksheetRootNamespaces(sourceXml: string, destinationXml: string): string {
  const sourceRoot = getWorksheetRootTag(sourceXml);
  const destinationRoot = getWorksheetRootTag(destinationXml);
  if (!sourceRoot || !destinationRoot) {
    throw new Error('Worksheet root element is missing while restoring extensions.');
  }

  let mergedRoot = destinationRoot;
  const sourceNamespaces = getNamespaceAttributes(sourceRoot);
  const destinationNamespaces = getNamespaceAttributes(mergedRoot);

  for (const [name, value] of Array.from(sourceNamespaces.entries())) {
    if (!destinationNamespaces.has(name)) {
      mergedRoot = appendXmlAttribute(mergedRoot, name, value);
    }
  }

  const sourceIgnorable = getXmlAttribute(sourceRoot, 'mc:Ignorable');
  if (sourceIgnorable) {
    const destinationIgnorable = getXmlAttribute(mergedRoot, 'mc:Ignorable');
    const tokens = new Set([
      ...(destinationIgnorable ? destinationIgnorable.split(/\s+/) : []),
      ...sourceIgnorable.split(/\s+/),
    ].filter(Boolean));
    mergedRoot = setXmlAttribute(mergedRoot, 'mc:Ignorable', Array.from(tokens).join(' '));
  }

  return destinationXml.replace(destinationRoot, mergedRoot);
}

export function getUnboundWorksheetExtensionPrefixes(xml: string): string[] {
  const root = getWorksheetRootTag(xml);
  const extLst = xml.match(/<extLst>[\s\S]*?<\/extLst>/)?.[0];
  if (!root || !extLst) {
    return [];
  }

  const declared = new Set<string>();
  for (const name of Array.from(getNamespaceAttributes(root).keys())) {
    if (name.startsWith('xmlns:')) declared.add(name.slice('xmlns:'.length));
  }
  for (const name of Array.from(getNamespaceAttributes(extLst).keys())) {
    if (name.startsWith('xmlns:')) declared.add(name.slice('xmlns:'.length));
  }

  const used = new Set<string>();
  const prefixPattern = /<\/?([A-Za-z_][\w.-]*):[\w.-]+|\s([A-Za-z_][\w.-]*):[\w.-]+=/g;
  let match: RegExpExecArray | null;
  while ((match = prefixPattern.exec(extLst)) !== null) {
    used.add(match[1] || match[2]);
  }

  return Array.from(used)
    .filter((prefix) => prefix !== 'xml' && prefix !== 'xmlns' && !declared.has(prefix))
    .sort();
}

function getWorksheetRootTag(xml: string): string | null {
  return xml.match(/<worksheet\b[^>]*>/)?.[0] || null;
}

function getNamespaceAttributes(xmlTag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const namespacePattern = /\s(xmlns(?::[A-Za-z_][\w.-]*)?)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = namespacePattern.exec(xmlTag)) !== null) {
    attributes.set(match[1], match[2]);
  }
  return attributes;
}

function getXmlAttribute(xmlTag: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xmlTag.match(new RegExp(`\\s${escapedName}="([^"]*)"`))?.[1];
}

function appendXmlAttribute(xmlTag: string, name: string, value: string): string {
  return xmlTag.replace(/\/$|>$/, (suffix) => ` ${name}="${value}"${suffix}`);
}

function setXmlAttribute(xmlTag: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attribute = new RegExp(`\\s${escapedName}="[^"]*"`);
  return attribute.test(xmlTag)
    ? xmlTag.replace(attribute, ` ${name}="${value}"`)
    : appendXmlAttribute(xmlTag, name, value);
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
