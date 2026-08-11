export const ROW_ANCHOR_BATCH_BUDGET_MS = 6_000;
export const FIRST_STUDENT_DIGIT_OCR_BUDGET_MS = 6_000;
export const FOLLOWING_STUDENT_DIGIT_OCR_BUDGET_MS = 1_000;

export interface RecognitionOcrDeadlines {
  ocrDeadlineAt: number;
  digitOcrDeadlineAt: number;
}

/**
 * Row OCR is deliberately bounded for the whole batch. The tiny age crop gets
 * its own per-student budget so a later student is not skipped solely because
 * earlier pages consumed the shared row-detection budget.
 */
export function createRecognitionOcrDeadlines(
  rowOcrDeadlineAt: number,
  studentIndex: number,
  now = Date.now(),
): RecognitionOcrDeadlines {
  const digitOcrBudgetMs = studentIndex === 0
    ? FIRST_STUDENT_DIGIT_OCR_BUDGET_MS
    : FOLLOWING_STUDENT_DIGIT_OCR_BUDGET_MS;

  return {
    ocrDeadlineAt: rowOcrDeadlineAt,
    digitOcrDeadlineAt: now + digitOcrBudgetMs,
  };
}
