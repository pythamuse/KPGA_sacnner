import { describe, expect, it } from 'vitest';
import {
  createRecognitionOcrDeadlines,
  FIRST_STUDENT_DIGIT_OCR_BUDGET_MS,
  FOLLOWING_STUDENT_DIGIT_OCR_BUDGET_MS,
  ROW_ANCHOR_BATCH_BUDGET_MS,
} from '../src/lib/recognition/ocrBudget';

describe('recognition OCR budgets', () => {
  it('keeps row OCR batch-bounded while giving every student a fresh digit OCR deadline', () => {
    const now = 1_000_000;
    const rowOcrDeadlineAt = now + ROW_ANCHOR_BATCH_BUDGET_MS;

    const firstStudent = createRecognitionOcrDeadlines(rowOcrDeadlineAt, 0, now);
    const secondStudent = createRecognitionOcrDeadlines(rowOcrDeadlineAt, 1, now + 7_000);

    expect(firstStudent).toEqual({
      ocrDeadlineAt: rowOcrDeadlineAt,
      digitOcrDeadlineAt: now + FIRST_STUDENT_DIGIT_OCR_BUDGET_MS,
    });
    expect(secondStudent.ocrDeadlineAt).toBe(rowOcrDeadlineAt);
    expect(secondStudent.digitOcrDeadlineAt).toBe(now + 7_000 + FOLLOWING_STUDENT_DIGIT_OCR_BUDGET_MS);
    expect(secondStudent.digitOcrDeadlineAt).toBeGreaterThan(rowOcrDeadlineAt);
  });
});
