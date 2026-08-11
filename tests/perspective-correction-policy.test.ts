import { describe, expect, it } from 'vitest';
import {
  hasBatchPerspectiveCorrectionCandidate,
  shouldCorrectBatchPerspective,
} from '../src/lib/documentScanner/perspectiveCorrectionPolicy';

describe('batch perspective correction policy', () => {
  it('does not send already-flat PDF render pages to the camera correction worker', () => {
    expect(shouldCorrectBatchPerspective('pdf')).toBe(false);
    expect(hasBatchPerspectiveCorrectionCandidate(['pdf', 'pdf'])).toBe(false);
  });

  it('keeps direct image uploads eligible for camera perspective correction', () => {
    expect(shouldCorrectBatchPerspective('image')).toBe(true);
    expect(hasBatchPerspectiveCorrectionCandidate(['pdf', 'image'])).toBe(true);
  });
});
