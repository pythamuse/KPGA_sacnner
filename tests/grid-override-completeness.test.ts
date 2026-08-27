import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeChoiceGroup, type ImageAnalysisData } from '../src/lib/recognition/markDensity';
import {
  buildFixedTemplateCandidateRects,
  buildRowFallbackCandidateRects,
  resolveRecognitionCropSource,
  resolveScoringCells,
} from '../src/lib/recognition/detectCheckmarks';
import {
  completeOverrideOrNull,
  type GridDetectionResult,
} from '../src/lib/recognition/tableGridDetection';
import { cagiTemplate, getTemplate, type ChoiceGroup } from '../src/lib/recognition/roiTemplates';

/**
 * Grid detection can return fewer cells for a field than the question has
 * choices. Every consumer indexes that set positionally, so a short set
 * re-maps values onto the wrong choices and lets the alignment search wander
 * into a neighbouring column's ink. These tests pin the structural guard that
 * discards such a set in favour of the template rects
 * (Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md §8).
 */

const image = {
  width: 1000,
  height: 1400,
  contentBounds: { left: 100, top: 100, right: 900, bottom: 1300 },
};

function getCagiGroup(field: string): ChoiceGroup {
  const group = cagiTemplate.choiceGroups.find((candidate) => candidate.field === field);
  if (!group) throw new Error(`Missing CAGI template group ${field}`);
  return group;
}

function makeGridCells(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    left: 400 + index * 25,
    right: 420 + index * 25,
    top: 900,
    bottom: 930,
  }));
}

const verifiedGridRegistration = {
  tableId: 'cagi.primary',
  source: 'grid',
  status: 'verified',
} as const;

describe('completeOverrideOrNull', () => {
  const group = getCagiGroup('cagi.q01');

  it('keeps a set that covers every choice exactly once', () => {
    const cells = makeGridCells(group.candidates.length);
    expect(completeOverrideOrNull(cells, group.candidates.length)).toBe(cells);
  });

  it('discards a truncated set', () => {
    expect(group.candidates.length).toBeGreaterThan(2);
    expect(completeOverrideOrNull(makeGridCells(1), group.candidates.length)).toBeNull();
    expect(completeOverrideOrNull(makeGridCells(2), group.candidates.length)).toBeNull();
  });

  it('discards a set with more cells than choices, and an absent set', () => {
    expect(completeOverrideOrNull(makeGridCells(group.candidates.length + 1), group.candidates.length))
      .toBeNull();
    expect(completeOverrideOrNull(undefined, group.candidates.length)).toBeNull();
  });
});

describe('scoring geometry never uses a truncated grid override', () => {
  const group = getCagiGroup('cagi.q01');

  it('falls back to the template rects even when the grid registration is verified', () => {
    const truncated = makeGridCells(2);

    const scoringCells = resolveScoringCells(image, group, truncated, undefined, verifiedGridRegistration);

    expect(scoringCells).toEqual(buildFixedTemplateCandidateRects(image, group));
    expect(scoringCells).not.toBe(truncated);
    expect(scoringCells).toHaveLength(group.candidates.length);
  });

  it('prefers the detected response row over the truncated cells when one exists', () => {
    const truncated = makeGridCells(1);
    const row = { top: 300, bottom: 340 };

    const scoringCells = resolveScoringCells(image, group, truncated, row, verifiedGridRegistration);

    expect(scoringCells).toEqual(buildRowFallbackCandidateRects(image, group, row));
    expect(scoringCells).toHaveLength(group.candidates.length);
  });

  it('still uses a complete grid override, so the guard only removes the truncated case', () => {
    const complete = makeGridCells(group.candidates.length);

    expect(resolveScoringCells(image, group, complete, undefined, verifiedGridRegistration))
      .toBe(complete);
  });

  it('reports the template crop source once the truncated override is discarded', () => {
    const truncated = makeGridCells(2);
    const kept = completeOverrideOrNull(truncated, group.candidates.length) ?? undefined;

    // The recognition loop reads the override through the guard once and hands
    // that single value to the crop bookkeeping, so a discarded set can never
    // be labelled 'grid' in the review crops.
    expect(resolveRecognitionCropSource(kept, undefined, verifiedGridRegistration)).toBe('fixed');
    expect(resolveRecognitionCropSource(kept, { top: 300, bottom: 340 }, verifiedGridRegistration))
      .toBe('row');
    expect(resolveRecognitionCropSource(truncated, undefined, verifiedGridRegistration)).toBe('grid');
  });
});

describe('the scorer never reads values off a truncated cell set', () => {
  // 100x60 page, blank except for one solid ink block at x 60-80, y 20-40.
  function makeInkedImage(): ImageAnalysisData {
    const width = 100;
    const height = 60;
    const pixels = Buffer.alloc(width * height, 255);
    for (let y = 20; y < 40; y++) {
      for (let x = 60; x < 80; x++) {
        pixels[y * width + x] = 0;
      }
    }
    return { width, height, pixels, contentBoundsConfident: true };
  }

  // Value 0 sits on the ink by template geometry; value 1 sits on blank paper.
  const group: ChoiceGroup = {
    field: 'cagi.q04',
    candidates: [
      { value: 0, rect: { x: 0.6, y: 0.33, width: 0.2, height: 0.34 } },
      { value: 1, rect: { x: 0.1, y: 0.33, width: 0.2, height: 0.34 } },
    ],
  };

  const inkCell = { left: 60, top: 20, right: 80, bottom: 40 };
  const blankCell = { left: 10, top: 20, right: 30, bottom: 40 };

  it('ignores a one-cell override for a two-choice group and scores the template rects', () => {
    const result = analyzeChoiceGroup(makeInkedImage(), group, undefined, true, [blankCell]);

    expect(result.decision).toContain('cells=0');
    expect(result.decision).toContain(`n=${group.candidates.length}`);
    expect(result.value).toBe(0);
    expect(result.confidence).toBe('high');
  });

  it('honours a complete override, which is what makes the truncated case a real loss of mapping', () => {
    const result = analyzeChoiceGroup(makeInkedImage(), group, undefined, true, [blankCell, inkCell]);

    expect(result.decision).toContain('cells=1');
    expect(result.value).toBe(1);
    expect(result.confidence).toBe('high');
  });
});

describe('blank form baseline discards truncated grid overrides', () => {
  afterEach(() => {
    vi.doUnmock('../src/lib/recognition/tableGridDetection');
    vi.resetModules();
  });

  it.each(['cagi', 'satisfaction'] as const)(
    'keeps one baseline rect per choice for %s when the grid returns short cell sets',
    async (formType) => {
      vi.resetModules();
      vi.doMock('../src/lib/recognition/tableGridDetection', async () => {
        const actual = await vi.importActual<typeof import('../src/lib/recognition/tableGridDetection')>(
          '../src/lib/recognition/tableGridDetection',
        );
        const truncate = (result: GridDetectionResult): GridDetectionResult => ({
          ...result,
          overrides: Object.fromEntries(
            Object.entries(result.overrides).map(([field, cells]) => [field, cells.slice(0, 1)]),
          ),
        });
        return {
          ...actual,
          buildCagiGridDetection: (...args: Parameters<typeof actual.buildCagiGridDetection>) =>
            truncate(actual.buildCagiGridDetection(...args)),
          buildSatisfactionGridDetection: (...args: Parameters<typeof actual.buildSatisfactionGridDetection>) =>
            truncate(actual.buildSatisfactionGridDetection(...args)),
        };
      });

      const { loadBlankFormBaseline } = await import('../src/lib/recognition/templateBaseline');
      const baseline = await loadBlankFormBaseline(formType);
      const template = getTemplate(formType);

      expect(baseline).toBeDefined();
      for (const group of template.choiceGroups) {
        // Without the guard the truncated one-rect set would be carried
        // straight through for every field the grid resolved.
        expect(baseline?.candidateRects[group.field]).toHaveLength(group.candidates.length);
      }
    },
  );
});
