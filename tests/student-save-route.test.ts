import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/excel/generateWorkbookPair', () => ({
  generateWorkbookPair: vi.fn(async () => ({
    cagiBuffer: Buffer.alloc(0),
    satisfactionBuffer: Buffer.alloc(0),
    verifyResult: { ok: true, errors: [] },
  })),
}));

vi.mock('../src/lib/labelExport/labelStore', () => ({
  appendRecognitionLabels: vi.fn(async () => []),
}));

import { POST } from '../src/app/api/students/route';
import type { StudentData } from '../src/lib/validation/types';
import { REVIEW_FIELD_KEYS } from '../src/lib/review/settlement';

function fullSourceMap(source: 'confirmed' | 'manual' | 'blank_ok' = 'confirmed') {
  return Object.fromEntries(REVIEW_FIELD_KEYS.map((key) => [key, source]));
}

function makeStudent(source?: Record<string, string>): StudentData {
  return {
    source: {
      cagiImageId: 'cagi_page_0001',
      satisfactionImageId: 'satisfaction_page_0001',
      ...(source ? { recognitionValueSource: source } : {}),
    },
    basic: { age: 14, gender: '여', schoolType: '중학교', grade: '2학년' },
    cagi: { q01: 0, q02: 0, q03: 0, q04: 0, q05: 0, q06: 0, q07: 0, q08: 0, q09: 0 },
    satisfaction: { q01: 4, q02: 1, q03: 1, q04: 1, q05: 1, q06: 1, q07: 4, q08: 4, q09: 4, q10: 4 },
    status: 'draft',
  } as StudentData;
}

async function save(student: StudentData) {
  return POST(new Request('http://localhost/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: 'job_b11_route', students: [student], index: 0 }),
  }));
}

describe('POST /api/students settlement defense', () => {
  it('rejects a value whose source is automatic and lists the field key', async () => {
    const response = await save(makeStudent({ ...fullSourceMap(), 'basic.gender': 'auto' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.fields).toEqual(['basic.gender']);
    expect(body.error).toContain('basic.gender');
  });

  it('saves a fully reviewed student as confirmed and keeps the source map', async () => {
    const source = fullSourceMap();
    const response = await save(makeStudent(source));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.student.status).toBe('confirmed');
    expect(body.student.source.recognitionValueSource).toEqual(source);
  });

  it('accepts a legacy request without a source map as saved', async () => {
    const response = await save(makeStudent());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.student.status).toBe('saved');
    expect(body.student.source.recognitionValueSource).toBeUndefined();
  });
});
