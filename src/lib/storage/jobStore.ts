import { StudentData } from '../validation/types';
import fs from 'fs';
import path from 'path';
import { FormTrack, getJobDir, getJobFiles, initJobWorkspace } from '../excel/templateManager';

export interface JobSession {
  jobId: string;
  track: FormTrack;
  students: StudentData[];
  createdAt: number;
}

// 인메모리 간이 세션 저장소 (단일 강사 로컬 구동용)
const activeJobs = new Map<string, JobSession>();
export const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_FILE = 'session.json';
const JOB_ID_PATTERN = /^job_\d+$/;

function getSessionPath(jobId: string): string {
  return path.join(getJobDir(jobId), SESSION_FILE);
}

function saveJobSession(session: JobSession): void {
  const jobDir = getJobDir(session.jobId);
  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  fs.writeFileSync(getSessionPath(session.jobId), JSON.stringify(session, null, 2));
}

function loadJobSession(jobId: string): JobSession | undefined {
  const sessionPath = getSessionPath(jobId);
  if (!fs.existsSync(sessionPath)) {
    return undefined;
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as JobSession;
    if (!session.jobId || !Array.isArray(session.students) || typeof session.createdAt !== 'number') {
      return undefined;
    }
    if (session.track !== 'adult') {
      session.track = 'youth'; // 구버전 session.json 호환
    }

    activeJobs.set(jobId, session);
    return session;
  } catch {
    return undefined;
  }
}

export function createJobSession(jobId: string, track: FormTrack = 'youth'): JobSession {
  const session: JobSession = {
    jobId,
    track,
    students: [],
    createdAt: Date.now()
  };
  activeJobs.set(jobId, session);
  saveJobSession(session);
  return session;
}

export function getJobSession(jobId: string): JobSession | undefined {
  return activeJobs.get(jobId) || loadJobSession(jobId);
}

export function hasJobSession(jobId: string): boolean {
  return Boolean(getJobSession(jobId));
}

/**
 * track을 명시하지 않으면(예: 업로드 API처럼 트랙을 모르는 호출부) 기존 세션의
 * track을 그대로 쓴다. 세션이 아예 없는 복구 상황(예: Vercel 콜드 스타트로
 * session.json까지 유실된 경우)에만 track 기본값(youth)으로 새로 만든다.
 */
export function ensureJobSession(jobId: string, track?: FormTrack): JobSession | undefined {
  const existing = getJobSession(jobId);
  if (existing) {
    ensureJobWorkspaceFiles(jobId, existing.track);
    return existing;
  }

  if (!JOB_ID_PATTERN.test(jobId)) {
    return undefined;
  }

  const resolvedTrack = track || 'youth';
  ensureJobWorkspaceFiles(jobId, resolvedTrack);
  return createJobSession(jobId, resolvedTrack);
}

function ensureJobWorkspaceFiles(jobId: string, track: FormTrack): void {
  const files = getJobFiles(jobId, track);
  if (!fs.existsSync(files.cagiPath) || !fs.existsSync(files.satisfactionPath)) {
    initJobWorkspace(jobId, track);
  }
}

export function clearJobUploads(jobId: string) {
  if (!hasJobSession(jobId)) {
    throw new Error(`작업 세션 ${jobId}를 찾을 수 없습니다.`);
  }

  const uploadDir = path.join(getJobDir(jobId), 'uploads');
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
}

export function deleteJobWorkspace(jobId: string) {
  activeJobs.delete(jobId);
  jobLocks.delete(jobId);

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

  activeJobs.set(jobId, session);
  saveJobSession(session);
}

export function removeStudentFromSession(jobId: string, studentIndex: number) {
  const session = getJobSession(jobId);
  if (session) {
    session.students = session.students.filter(s => s.studentIndex !== studentIndex);
    activeJobs.set(jobId, session);
    saveJobSession(session);
  }
}

// jobId별 저장 요청을 직렬화한다. 학생 저장은 "행 번호 계산 -> 엑셀 쓰기 -> 검증 ->
// 세션 반영"까지 여러 await를 거치는데, 같은 jobId로 두 요청이 겹치면 둘 다 같은
// targetRow를 계산해 서로의 엑셀 행을 덮어쓸 수 있다(더블클릭, 다중 탭 등).
// 같은 Node 프로세스 안에서는 이 락으로 직렬화되지만, Vercel처럼 요청이 서로 다른
// 함수 인스턴스로 분산되는 환경의 동시 저장까지는 막지 못한다.
const jobLocks = new Map<string, Promise<unknown>>();

export function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(jobId) || Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  jobLocks.set(jobId, run.catch(() => undefined));
  return run;
}
