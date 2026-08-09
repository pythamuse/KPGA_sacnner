import { describe, expect, it } from 'vitest';
import {
  resolveRecognitionCropDiagnostic,
  resolveRecognitionCropSource,
} from '../src/lib/recognition/detectCheckmarks';

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

  it('keeps diagnostics only for fixed crops and combines grid and row failures', () => {
    expect(resolveRecognitionCropDiagnostic(
      'fixed',
      '격자: insufficient_lines (가로선 2/4개, 세로선 5/5개)',
      '행: 픽셀 gap_mismatch (행 선 간격 패턴 불일치); OCR lines_undetected (행 선 0/9개)',
    )).toBe('격자: insufficient_lines (가로선 2/4개, 세로선 5/5개); 행: 픽셀 gap_mismatch (행 선 간격 패턴 불일치); OCR lines_undetected (행 선 0/9개)');
    expect(resolveRecognitionCropDiagnostic(
      'grid',
      '격자: gap_mismatch (감지선 간격 패턴 불일치)',
    )).toBeUndefined();
    expect(resolveRecognitionCropDiagnostic(
      'row',
      undefined,
      '행: gap_mismatch (행 선 간격 패턴 불일치)',
    )).toBeUndefined();
  });
});
