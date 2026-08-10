import { describe, expect, it } from 'vitest';
import {
  buildRowFallbackCandidateRects,
  resolveRecognitionCropDiagnostic,
  resolveRecognitionCropSource,
  resolveScoringCells,
} from '../src/lib/recognition/detectCheckmarks';
import { cagiTemplate } from '../src/lib/recognition/roiTemplates';

describe('recognition crop source provenance', () => {
  it('records grid only when the detected cells pass registration', () => {
    const cells = [
      { left: 10, top: 20, right: 30, bottom: 40 },
    ];
    const row = { top: 15, bottom: 45 };

    expect(resolveRecognitionCropSource(cells, row, {
      tableId: 'test-grid',
      source: 'grid',
      status: 'verified',
    })).toBe('grid');
    expect(resolveRecognitionCropSource(cells, row)).toBe('row-fallback');
    expect(resolveRecognitionCropSource(cells)).toBe('grid-candidate');
  });

  it('records row when only a row override exists', () => {
    expect(resolveRecognitionCropSource(undefined, { top: 15, bottom: 45 })).toBe('row');
  });

  it('records fixed when no detected crop override exists', () => {
    expect(resolveRecognitionCropSource()).toBe('fixed');
  });

  it('uses a row fallback with detected candidate columns when grid rows are unstable', () => {
    const group = cagiTemplate.choiceGroups.find((candidate) => candidate.field === 'cagi.q01');
    if (!group) throw new Error('Missing CAGI q01 template');

    const rejectedGrid = group.candidates.map((_, index) => ({
      left: 400 + index * 25,
      right: 420 + index * 25,
      top: 900,
      bottom: 930,
    }));
    const row = { top: 300, bottom: 340 };
    const image = {
      width: 1000,
      height: 1400,
      contentBounds: { left: 100, top: 100, right: 900, bottom: 1300 },
    };

    const directFallback = buildRowFallbackCandidateRects(image, group, row, rejectedGrid);
    const scoringCells = resolveScoringCells(image, group, rejectedGrid, row, {
      tableId: 'cagi.primary',
      source: 'grid',
      status: 'candidate',
      gapDeviation: { rows: 0.2, columns: 0.02 },
      residualRatio: { rows: 0.12, columns: 0.02 },
      candidateCenterDeviation: { x: 0.01, y: 0.04 },
    });

    expect(scoringCells).toEqual(directFallback);
    expect(scoringCells).not.toBe(rejectedGrid);
    expect(scoringCells?.every((cell) => cell.top >= row.top && cell.bottom <= row.bottom)).toBe(true);
    expect(scoringCells?.map((cell) => [cell.left, cell.right])).toEqual(
      rejectedGrid.map((cell) => [cell.left, cell.right]),
    );
  });

  it('uses a candidate grid for manual scoring when no row fallback exists', () => {
    const group = cagiTemplate.choiceGroups.find((candidate) => candidate.field === 'cagi.q01');
    if (!group) throw new Error('Missing CAGI q01 template');

    const candidateGrid = group.candidates.map((_, index) => ({
      left: 400 + index * 25,
      right: 420 + index * 25,
      top: 900,
      bottom: 930,
    }));
    const image = {
      width: 1000,
      height: 1400,
      contentBounds: { left: 100, top: 100, right: 900, bottom: 1300 },
    };

    const registration = {
      tableId: 'cagi.primary',
      source: 'grid',
      status: 'candidate',
      gapDeviation: { rows: 0.02, columns: 0.03 },
      residualRatio: { rows: 0.01, columns: 0.02 },
      candidateCenterDeviation: { x: 0.02, y: 0.01 },
    } as const;

    expect(resolveScoringCells(image, group, candidateGrid, undefined, registration)).toBe(candidateGrid);
    expect(resolveRecognitionCropSource(candidateGrid, { top: 850, bottom: 880 }, registration)).toBe('grid-candidate');
  });

  it('shows diagnostics for every non-verified crop source', () => {
    expect(resolveRecognitionCropDiagnostic(
      'fixed',
      'grid: insufficient_lines',
      'row: gap_mismatch',
    )).toBe('grid: insufficient_lines; row: gap_mismatch');
    expect(resolveRecognitionCropDiagnostic(
      'grid',
      'grid: gap_mismatch',
    )).toBe('grid: gap_mismatch');
    expect(resolveRecognitionCropDiagnostic(
      'grid-candidate',
      'grid candidate: choice center delta',
    )).toBe('grid candidate: choice center delta');
    expect(resolveRecognitionCropDiagnostic(
      'row',
      undefined,
      'row: gap_mismatch',
    )).toBe('row: gap_mismatch');
    expect(resolveRecognitionCropDiagnostic(
      'row-fallback',
      'grid candidate: choice center delta',
      'row: gap_mismatch',
    )).toContain('Grid candidate rejected; row fallback used.');
  });
});
