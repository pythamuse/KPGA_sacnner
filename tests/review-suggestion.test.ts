import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  analyzeChoiceGroup,
  selectReviewSuggestion,
  type ImageAnalysisData,
  type PixelRect,
  type ReviewSuggestionFeatures,
} from '../src/lib/recognition/markDensity';
import { recognizeStudentForms } from '../src/lib/recognition/detectCheckmarks';
import { cagiTemplate, satisfactionTemplate, type ChoiceGroup } from '../src/lib/recognition/roiTemplates';

const fixtureDir = path.join(process.cwd(), 'tmp', 'test-review-suggestion');

afterAll(() => {
  if (fs.existsSync(fixtureDir)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function feature(
  candidateIndex: number,
  pageMinusBlank: number | undefined,
  matchedScore: number | undefined,
): ReviewSuggestionFeatures {
  return { candidateIndex, value: candidateIndex, pageMinusBlank, matchedScore };
}

describe('review suggestion rule', () => {
  it('suggests the box both rankings put first', () => {
    expect(selectReviewSuggestion([
      feature(0, 0.004, 0.002),
      feature(1, 0.031, 0.019),
      feature(2, 0.007, 0.005),
      feature(3, 0.002, 0.001),
    ])).toEqual({ candidateIndex: 1, value: 1 });
  });

  it('says nothing when the two rankings disagree', () => {
    // Ink puts box 1 first, the structural score puts box 2 first. This is the
    // 33 of 192 groups the agreement filter drops, and dropping them is what
    // takes the measured hit rate from ~77% to 83%.
    expect(selectReviewSuggestion([
      feature(0, 0.004, 0.002),
      feature(1, 0.031, 0.006),
      feature(2, 0.020, 0.019),
    ])).toBeUndefined();
  });

  it('says nothing when either ranking ties at the top', () => {
    expect(selectReviewSuggestion([
      feature(0, 0.031, 0.004),
      feature(1, 0.031, 0.019),
    ])).toBeUndefined();
    expect(selectReviewSuggestion([
      feature(0, 0.031, 0.019),
      feature(1, 0.004, 0.019),
    ])).toBeUndefined();
  });

  it('says nothing about a single candidate', () => {
    // Trivially first on both features, which is not agreement about anything.
    expect(selectReviewSuggestion([feature(0, 0.031, 0.019)])).toBeUndefined();
  });

  it('says nothing when any box is missing either reading', () => {
    expect(selectReviewSuggestion([
      feature(0, 0.031, 0.019),
      feature(1, undefined, 0.004),
    ])).toBeUndefined();
    expect(selectReviewSuggestion([
      feature(0, 0.031, 0.019),
      feature(1, 0.004, undefined),
    ])).toBeUndefined();
    expect(selectReviewSuggestion([
      feature(0, 0.031, 0.019),
      feature(1, Number.NaN, 0.004),
    ])).toBeUndefined();
  });

  it('reads a negative ink difference as a ranking, not as missing', () => {
    // Every box on a page lighter than the blank form measures negative here.
    // The rule ranks within the group, so the least-negative box still wins.
    expect(selectReviewSuggestion([
      feature(0, -0.031, 0.002),
      feature(1, -0.004, 0.019),
    ])).toEqual({ candidateIndex: 1, value: 1 });
  });
});

const WIDTH = 400;
const HEIGHT = 120;

/**
 * A four-box row with unequal marks, and optional dark speckle that leaves the
 * page disagreeing with the blank everywhere at once.
 *
 * The speckle is what makes the group refuse: it lifts the leftover
 * disagreement so the relative-contrast test fails and the rescue route
 * declines, which is the state this whole feature exists for.
 */
function makeRow(markStrength: number, speckle: number): ImageAnalysisData {
  const pixels = Buffer.alloc(WIDTH * HEIGHT, 242);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let box = 0; box < 4; box++) {
    const left = 20 + box * 90;
    const strength = markStrength - box * 18;
    if (strength > 0) {
      for (let y = 44 + box; y < 62; y++) {
        for (let x = left + 18; x < left + 42; x++) {
          pixels[y * WIDTH + x] = Math.max(0, 242 - strength);
        }
      }
    }
  }
  for (let index = 0; index < pixels.length && speckle > 0; index++) {
    if (rand() < speckle / 1000) pixels[index] = 60;
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    pixels,
    contentBounds: { left: 0, top: 0, right: WIDTH, bottom: HEIGHT },
    contentBoundsSource: 'template',
    contentBoundsConfident: true,
  };
}

const rowCells = (): PixelRect[] => Array.from({ length: 4 }, (_, box) => ({
  left: 20 + box * 90,
  top: 30,
  right: 20 + box * 90 + 60,
  bottom: 80,
}));

const rowGroup: ChoiceGroup = {
  field: 'cagi.q01',
  candidates: [0, 1, 2, 3].map((value, index) => ({
    value,
    rect: { x: (20 + index * 90) / WIDTH, y: 30 / HEIGHT, width: 60 / WIDTH, height: 50 / HEIGHT },
  })),
};

describe('review suggestion on a scored group', () => {
  it('offers a default on a group it refused, and names it in the trace', () => {
    const result = analyzeChoiceGroup(
      makeRow(42, 260), rowGroup, undefined, true, rowCells(), true,
      { image: makeRow(0, 0), candidatePixelOverrides: rowCells() }, false,
    );

    // Precondition: if a threshold change ever lets this group through, the
    // suggestion is supposed to disappear and this test should say so plainly.
    expect(result.confidence).not.toBe('high');
    expect(result.value).toBeUndefined();
    expect(result.suggestion).toEqual({ candidateIndex: 0, value: 0 });
    expect(result.decision).toContain('suggest=0');
  });

  it('offers nothing on a group that reached an automatic value', () => {
    const image = makeRow(200, 0);
    const result = analyzeChoiceGroup(
      image, rowGroup, undefined, true, rowCells(), false,
      { image: makeRow(0, 0), candidatePixelOverrides: rowCells() }, false,
    );

    expect(result.confidence).toBe('high');
    expect(result.value).toBe(0);
    expect(result.suggestion).toBeUndefined();
    expect(result.decision).not.toContain('suggest=');
  });

  it('offers nothing without a blank form to measure against', () => {
    // The raw-density path has no per-box ink pair and no aligned residual, so
    // neither ranking exists.
    const result = analyzeChoiceGroup(
      makeRow(42, 260), rowGroup, undefined, true, rowCells(), true, undefined, false,
    );

    expect(result.confidence).not.toBe('high');
    expect(result.suggestion).toBeUndefined();
  });

  it('offers nothing when the grid was never verified', () => {
    // `allowAutoValue: false`. These are the cells the grid failed on, not the
    // ones the scorer refused, and the 83% was never measured on them.
    const result = analyzeChoiceGroup(
      makeRow(42, 260), rowGroup, undefined, false, rowCells(), true,
      { image: makeRow(0, 0), candidatePixelOverrides: rowCells() }, false,
    );

    expect(result.suggestion).toBeUndefined();
    expect(result.decision).not.toContain('suggest=');
  });
});

describe('review suggestion metadata path', () => {
  it('reaches the draft, and only for fields it left blank', async () => {
    const cagiPath = path.join(fixtureDir, 'cagi.png');
    const satisfactionPath = path.join(fixtureDir, 'satisfaction.png');
    const cagiDrawn: Record<string, number | string> = {
      'basic.gender': 'female',
      'cagi.q01': 1, 'cagi.q02': 1, 'cagi.q03': 2, 'cagi.q04': 2, 'cagi.q05': 3,
      'cagi.q06': 0, 'cagi.q07': 1, 'cagi.q08': 2, 'cagi.q09': 3,
    };
    const satisfactionDrawn: Record<string, number | string> = {
      'satisfaction.q01': 2, 'satisfaction.q02': 1, 'satisfaction.q03': 1,
      'satisfaction.q04': 0, 'satisfaction.q05': 1, 'satisfaction.q06': 0,
      'satisfaction.q07': 3, 'satisfaction.q08': 2, 'satisfaction.q09': 4, 'satisfaction.q10': 1,
    };
    const drawn = { ...cagiDrawn, ...satisfactionDrawn };
    await writeMarkedForm(cagiPath, cagiTemplate.choiceGroups, cagiDrawn, '#4a4a4a', '#565656');
    await writeMarkedForm(satisfactionPath, satisfactionTemplate.choiceGroups, satisfactionDrawn, '#4a4a4a', '#565656');

    const draft = await recognizeStudentForms(cagiPath, satisfactionPath);
    const suggestions = draft.recognitionSuggestion || {};

    expect(Object.keys(suggestions).length).toBeGreaterThan(0);
    for (const [field, suggestion] of Object.entries(suggestions)) {
      expect(suggestion.candidateIndex).toBeGreaterThanOrEqual(0);
      // The box that was actually drawn darkest, carried through the same
      // value mapping the review controls use. Synthetic ink says nothing
      // about accuracy on paper (CLAUDE.md §2); what it checks here is that
      // the metadata arrives naming the right box rather than an off-by-one.
      expect(suggestion.value, field).toBe(drawn[field]);
      // The absolute condition, asserted per field: a suggestion never comes
      // with a value, never with high confidence, and never on a field the
      // recognizer filled in automatically.
      const [group, name] = field.split('.');
      const value = group === 'basic'
        ? (draft.basic as Record<string, unknown>)[name]
        : group === 'cagi' ? draft.cagi[name] : draft.satisfaction[name];
      expect(value, `${field} should still be blank`).toBeUndefined();
      expect(draft.confidence[field], field).not.toBe('high');
      expect(draft.recognitionValueSource?.[field], field).not.toBe('auto');
    }
    // And nothing was offered for a field that did reach an automatic value.
    for (const [field, source] of Object.entries(draft.recognitionValueSource || {})) {
      if (source === 'auto') expect(suggestions[field], field).toBeUndefined();
    }
  }, 60000);
});

async function writeMarkedForm(
  filePath: string,
  groups: ChoiceGroup[],
  selectedValues: Record<string, number | string>,
  markFill: string,
  runnerUpFill: string,
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const width = 1000;
  const height = 1400;
  const pageBounds = { left: 100, top: 100, width: 800, height: 1200 };
  const template = groups.some((group) => group.field.startsWith('cagi.'))
    ? cagiTemplate
    : satisfactionTemplate;
  const registrationFrame = template.registrationFrame!;
  const bounds = {
    left: pageBounds.left + registrationFrame.x * pageBounds.width,
    top: pageBounds.top + registrationFrame.y * pageBounds.height,
    width: registrationFrame.width * pageBounds.width,
    height: registrationFrame.height * pageBounds.height,
  };

  // Two marks per row, the second only slightly lighter than the first. The
  // relative-contrast test then refuses the group -- which is the state a
  // review suggestion exists for -- while both rankings still separate the
  // boxes, so the rule has something to agree about.
  const marks = groups.flatMap((group) => {
    const selectedValue = selectedValues[group.field];
    if (selectedValue === undefined) return [];
    const index = group.candidates.findIndex((item) => item.value === selectedValue);
    if (index < 0) return [];
    const runnerUpIndex = (index + 1) % group.candidates.length;
    return [[index, markFill] as const, [runnerUpIndex, runnerUpFill] as const]
      .map(([candidateIndex, fill]) => {
        const candidate = group.candidates[candidateIndex];
        const cx = bounds.left + (candidate.rect.x + candidate.rect.width / 2) * bounds.width;
        const cy = bounds.top + (candidate.rect.y + candidate.rect.height / 2) * bounds.height;
        const radius = Math.max(candidate.rect.width * bounds.width, candidate.rect.height * bounds.height) * 0.62;
        return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}"/>`;
      });
  });

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#fff"/>
      <rect x="${pageBounds.left}" y="${pageBounds.top}" width="${pageBounds.width}" height="${pageBounds.height}" fill="none" stroke="#000" stroke-width="6"/>
      ${renderResponseGrids(groups, bounds)}
      ${marks.join('\n')}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

function renderResponseGrids(
  groups: ChoiceGroup[],
  bounds: { left: number; top: number; width: number; height: number },
  gridOffsetY = 0,
): string {
  const prefix = groups.some((group) => group.field.startsWith('cagi.')) ? 'cagi.' : 'satisfaction.';
  const specs = prefix === 'cagi.'
    ? [
      ['cagi.q01', 'cagi.q02', 'cagi.q03', 'cagi.q04', 'cagi.q05', 'cagi.q06', 'cagi.q07'],
      ['cagi.q08', 'cagi.q09'],
    ]
    : [
      ['satisfaction.q01'],
      ['satisfaction.q02', 'satisfaction.q03', 'satisfaction.q04', 'satisfaction.q05', 'satisfaction.q06'],
      ['satisfaction.q07', 'satisfaction.q08', 'satisfaction.q09', 'satisfaction.q10'],
    ];

  return specs.map((fields) => {
    const tableGroups = fields
      .map((field) => groups.find((group) => group.field === field))
      .filter((group): group is ChoiceGroup => Boolean(group));
    if (tableGroups.length !== fields.length) return '';

    const columnCenters = tableGroups[0].candidates.map((candidate) => candidate.rect.x + candidate.rect.width / 2);
    const rowCenters = tableGroups.map((group) => average(group.candidates.map(
      (candidate) => candidate.rect.y + candidate.rect.height / 2,
    )));
    const xLines = toPixels(deriveBoundaries(columnCenters), bounds.left, bounds.width);
    const yLines = toPixels(deriveBoundaries(rowCenters), bounds.top, bounds.height)
      .map((y) => y + Math.round(gridOffsetY * bounds.height));
    return [
      ...xLines.map((x) => `<line x1="${x}" y1="${yLines[0]}" x2="${x}" y2="${yLines[yLines.length - 1]}" stroke="#000" stroke-width="3"/>`),
      ...yLines.map((y) => `<line x1="${xLines[0]}" y1="${y}" x2="${xLines[xLines.length - 1]}" y2="${y}" stroke="#000" stroke-width="3"/>`),
    ].join('\n');
  }).join('\n');
}

function deriveBoundaries(centers: number[]): number[] {
  if (centers.length === 1) {
    return [centers[0] - 0.04, centers[0] + 0.04];
  }

  return [
    centers[0] - (centers[1] - centers[0]) / 2,
    ...centers.slice(1).map((center, index) => (centers[index] + center) / 2),
    centers[centers.length - 1] + (centers[centers.length - 1] - centers[centers.length - 2]) / 2,
  ];
}

function toPixels(values: number[], offset: number, size: number): number[] {
  return values.map((value) => Math.round(offset + value * size));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
