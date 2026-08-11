/**
 * PDF pages rendered by PDF.js are already flat, rectangular document images.
 * Perspective correction is reserved for camera/direct image uploads, where a
 * quadrilateral document may need to be found before template registration.
 */
export type BatchImageSource = 'image' | 'pdf';

export function shouldCorrectBatchPerspective(source: BatchImageSource): boolean {
  return source === 'image';
}

export function hasBatchPerspectiveCorrectionCandidate(sources: BatchImageSource[]): boolean {
  return sources.some(shouldCorrectBatchPerspective);
}
