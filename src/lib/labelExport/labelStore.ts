import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StudentData } from '../validation/types';
import type {
  LabelRow,
  LabelSource,
  RecognitionMeasurementsByField,
  StoredRecognitionMeasurements,
} from './types';

const LABEL_EXPORT_ROOT = path.join(os.tmpdir(), 'kpga-scanner', 'label-export');
const MEASUREMENTS_ROOT = path.join(LABEL_EXPORT_ROOT, 'measurements');
const LABELS_ROOT = path.join(LABEL_EXPORT_ROOT, 'labels');

interface ReviewMetadataSource {
  recognitionValueSource?: Record<string, string>;
  recognitionManualEditedAt?: Record<string, string>;
}

type LabelStudent = Pick<StudentData, 'basic' | 'cagi' | 'satisfaction'> & {
  source?: StudentData['source'] & ReviewMetadataSource;
};

export interface StoreRecognitionMeasurementsInput {
  jobId: string;
  studentIndex: number;
  cagiImageId: string;
  measurements: RecognitionMeasurementsByField;
}

export interface AppendRecognitionLabelsInput {
  jobId: string;
  /** Fallback only for a legacy sidecar that predates studentIndex. */
  studentIndex: number;
  cagiImageId: string;
  student: LabelStudent;
}

export function getRecognitionMeasurementsPath(jobId: string, cagiImageId: string): string {
  return path.join(
    MEASUREMENTS_ROOT,
    safePathSegment(jobId, 'jobId'),
    `${safePathSegment(cagiImageId, 'cagiImageId')}.json`,
  );
}

export function getLabelJsonlPath(jobId: string): string {
  return path.join(LABELS_ROOT, `${safePathSegment(jobId, 'jobId')}.jsonl`);
}

/**
 * Keeps the recognition-time measurements off the browser and off Vercel.
 * A student key is a job plus the CAGI image id that survives review/save.
 */
export async function storeRecognitionMeasurements(
  input: StoreRecognitionMeasurementsInput,
): Promise<void> {
  if (isVercel() || Object.keys(input.measurements).length === 0) return;

  const filePath = getRecognitionMeasurementsPath(input.jobId, input.cagiImageId);
  const record: StoredRecognitionMeasurements = {
    ...input,
    measurements: input.measurements,
  };
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(record), 'utf8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readRecognitionMeasurements(
  jobId: string,
  cagiImageId: string,
): Promise<StoredRecognitionMeasurements | undefined> {
  if (isVercel()) return undefined;

  try {
    const raw = await fs.readFile(getRecognitionMeasurementsPath(jobId, cagiImageId), 'utf8');
    const parsed = JSON.parse(raw) as StoredRecognitionMeasurements;
    if (
      parsed.jobId !== jobId
      || parsed.cagiImageId !== cagiImageId
      || !parsed.measurements
      || typeof parsed.measurements !== 'object'
    ) {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Joins the final reviewed values with the server-side measurements and
 * appends one JSON object per candidate cell. There is intentionally no
 * replace/deduplicate path: a later save is the consumer's latest record.
 */
export async function appendRecognitionLabels(
  input: AppendRecognitionLabelsInput,
): Promise<LabelRow[]> {
  if (isVercel()) return [];

  const stored = await readRecognitionMeasurements(input.jobId, input.cagiImageId);
  if (!stored) return [];

  const source = input.student.source;
  const valueSources = source?.recognitionValueSource || {};
  const editedAt = source?.recognitionManualEditedAt || {};
  const studentIndex = Number.isInteger(stored.studentIndex)
    ? stored.studentIndex
    : input.studentIndex;
  const rows: LabelRow[] = [];

  for (const [field, measurements] of Object.entries(stored.measurements)) {
    const finalValue = readStudentField(input.student, field);
    const labelSource = resolveLabelSource(valueSources[field], editedAt[field]);
    const sortedMeasurements = [...measurements].sort((a, b) => a.candidateIndex - b.candidateIndex);

    for (const measurement of sortedMeasurements) {
      const label: 0 | 1 = labelSource === 'blank_ok'
        ? 0
        : hasValue(finalValue) && valuesEqual(finalValue, measurement.candidateValue)
          ? 1
          : 0;
      rows.push({
        ...measurement,
        jobId: input.jobId,
        studentIndex,
        field,
        label,
        labelSource,
      });
    }
  }

  if (rows.length === 0) return rows;

  const serialized = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const filePath = getLabelJsonlPath(input.jobId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, serialized, 'utf8');
  return rows;
}

/**
 * The persisted sources intentionally exclude `unresolved`. A legacy or
 * hand-built request without the newer review source metadata is treated as a
 * manual value when it carries an edit timestamp, and as manual otherwise;
 * only an explicit `auto` source is allowed to enter the auto bucket.
 */
export function resolveLabelSource(source?: string, editedAt?: string): LabelSource {
  if (source === 'auto') return 'auto';
  if (source === 'restored') return 'restored';
  if (source === 'confirmed') return 'confirmed';
  if (source === 'blank_ok') return 'blank_ok';
  if (source === 'manual' || editedAt) return 'manual';
  return 'manual';
}

export async function resetLabelExportForTests(jobId: string): Promise<void> {
  if (isVercel()) return;
  await Promise.all([
    fs.rm(path.join(MEASUREMENTS_ROOT, safePathSegment(jobId, 'jobId')), { recursive: true, force: true }),
    fs.rm(getLabelJsonlPath(jobId), { force: true }),
  ]);
}

function readStudentField(student: LabelStudent, field: string): unknown {
  const [group, name] = field.split('.');
  if (group === 'basic' || group === 'cagi' || group === 'satisfaction') {
    return (student[group] as Record<string, unknown> | undefined)?.[name];
  }
  return undefined;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return String(left) === String(right);
}

function safePathSegment(value: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Unsafe ${name} for label export.`);
  }
  return value;
}

function isVercel(): boolean {
  return process.env.VERCEL !== undefined;
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}
