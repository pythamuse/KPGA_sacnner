import { describe, expect, it } from 'vitest';
import { resolveRecognitionCropSource } from '../src/lib/recognition/detectCheckmarks';

describe('recognition crop source provenance', () => {
  it('records grid when candidate cell overrides exist', () => {
    expect(resolveRecognitionCropSource([
      { left: 10, top: 20, right: 30, bottom: 40 },
    ], { top: 15, bottom: 45 })).toBe('grid');
  });

  it('records row when only a row override exists', () => {
    expect(resolveRecognitionCropSource(undefined, { top: 15, bottom: 45 })).toBe('row');
  });

  it('records fixed when no detected crop override exists', () => {
    expect(resolveRecognitionCropSource()).toBe('fixed');
  });
});
