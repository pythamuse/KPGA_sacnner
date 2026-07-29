import { StudentData } from '../validation/types';
import fs from 'fs';
import path from 'path';
import { getJobDir } from '../excel/templateManager';

export interface JobSession {
  jobId: string;
  students: StudentData[];
  createdAt: number;
}

// 인메모리 간이 세션 저장소 (단일 강사 로컬 구동용)
const activeJobs = new Map<string, JobSession>();
export const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

export function createJobSession(jobId: string): JobSession {
  const session: JobSession = {
    jobId,
    students: [],
    createdAt: Date.now()
  };
  activeJobs.set(jobId, session);
  return session;
}

export function getJobSession(jobId: string): JobSession | undefined {
  return activeJobs.get(jobId);
}

export function hasJobSession(jobId: string): boolean {
  return activeJobs.has(jobId);
}

export function clearJobUploads(jobId: string) {
  if (!hasJobSession(jobId)) {
    throw new Error(`?묒뾽 ?몄뀡 ${jobId}??李얠쓣 ???놁뒿?덈떎.`);
  }

  const uploadDir = path.join(getJobDir(jobId), 'uploads');
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

export function deleteJobWorkspace(jobId: string) {
  activeJobs.delete(jobId);

  const jobDir = getJobDir(jobId);
  if (fs.existsSync(jobDir)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

export function cleanupExpiredJobs(now = Date.now(), ttlMs = DEFAULT_JOB_TTL_MS): string[] {
  const removedJobIds: string[] = [];

  for (const [jobId, session] of Array.from(activeJobs.entries())) {
    if (now - session.createdAt <= ttlMs) continue;

    deleteJobWorkspace(jobId);
    removedJobIds.push(jobId);
  }

  return removedJobIds;
}

export function addStudentToSession(jobId: string, student: StudentData) {
  const session = getJobSession(jobId);
  if (!session) {
    throw new Error(`작업 세션 ${jobId}을 찾을 수 없습니다.`);
  }

  // 중복 저장 방지 혹은 덮어쓰기
  const existingIdx = session.students.findIndex(s => s.studentIndex === student.studentIndex);
  if (existingIdx !== -1) {
    session.students[existingIdx] = student;
  } else {
    student.studentIndex = 3 + session.students.length; // target Row 번호와 싱크를 위해 설정
    session.students.push(student);
  }
}

export function removeStudentFromSession(jobId: string, studentIndex: number) {
  const session = getJobSession(jobId);
  if (session) {
    session.students = session.students.filter(s => s.studentIndex !== studentIndex);
  }
}
