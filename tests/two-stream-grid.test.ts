import { describe, expect, it, vi } from 'vitest';
import path from 'path';
import sharp from 'sharp';
import {
  GRID_STREAM_DIAGNOSTIC_KEY,
  recognizeStudentForms,
  selectGridDetectionStream,
} from '../src/lib/recognition/detectCheckmarks';
import { loadImageAnalysisData, type ImageAnalysisData } from '../src/lib/recognition/markDensity';
import {
  buildCagiGridDetection,
  buildSatisfactionGridDetection,
  type GridDetectionResult,
} from '../src/lib/recognition/tableGridDetection';
import {
  FLATTEN_SIGMA_DIVISOR,
  FLATTEN_TARGET_PAPER_LEVEL,
  buildFlattenedGeometryImage,
  flattenIllumination,
  resolveFlattenSigma,
} from '../src/lib/recognition/illuminationFlatten';

/**
 * Two-stream geometry for photographed sheets
 * (Task/FEATURE_SPEC_CAPTURE_PIPELINE_2026-08-27.md §9.2 row V-C).
 *
 * These are logic tests on the committed blank assets and on synthetic
 * buffers. No scan, photo or answer key exists in this checkout, so nothing
 * here says anything about recognition accuracy — the claims are: a scan
 * computes no flattened copy, a photo sheet keeps whichever stream resolved
 * more fields, a tie keeps raw, and the flattened pixels never leave the
 * detector.
 */

const fixtureDir = path.join(process.cwd(), 'tests', 'fixtures', 'blank-form');
const cagiPath = path.join(fixtureDir, 'cagi-blank.png');
const satisfactionPath = path.join(fixtureDir, 'satisfaction-blank.png');

function makeImage(): ImageAnalysisData {
  return {
    width: 4,
    height: 4,
    pixels: Buffer.alloc(16, 255),
    contentBounds: { left: 0, top: 0, right: 4, bottom: 4 },
    contentBoundsSource: 'paper',
    contentBoundsConfident: true,
  };
}

function detectionWithFields(count: number, tag: string): GridDetectionResult {
  return {
    overrides: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`${tag}.field${index}`, []]),
    ),
    fieldRects: {},
    registrations: {},
  };
}

/**
 * Multiplies the page toward dark along x, the way a lamp on one side of the
 * desk does, so the fixed dark threshold the rule detector uses swallows the
 * shaded half of the paper.
 *
 * The multiply runs through sharp on a three-channel intermediate. sharp's
 * `multiply` blend on a single-channel raw input does not produce the
 * multiply: measured on an 8x4 probe, a 255->127 gradient over a flat 200
 * page came back as 190 on the bright side and 255 on the dark side. The
 * three-channel path matches an exact per-pixel multiply to within one grey
 * level.
 */
async function darkenWithGradient(image: ImageAnalysisData, minScale: number): Promise<Buffer> {
  const { width, height } = image;
  const gradient = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const level = Math.round(255 * (1 - (1 - minScale) * (x / Math.max(width - 1, 1))));
      const index = (y * width + x) * 3;
      gradient[index] = level;
      gradient[index + 1] = level;
      gradient[index + 2] = level;
    }
  }

  return sharp(image.pixels, { raw: { width, height, channels: 1 } })
    .toColourspace('srgb')
    .composite([{ input: gradient, raw: { width, height, channels: 3 }, blend: 'multiply' }])
    .grayscale()
    .raw()
    .toBuffer();
}

const sheets: Array<{
  name: string;
  filePath: string;
  build: (image: ImageAnalysisData) => GridDetectionResult;
}> = [
  { name: 'cagi', filePath: cagiPath, build: buildCagiGridDetection },
  { name: 'satisfaction', filePath: satisfactionPath, build: buildSatisfactionGridDetection },
];

describe('illumination flattening', () => {
  it('derives sigma as round(min(width, height) / 16)', () => {
    expect(FLATTEN_SIGMA_DIVISOR).toBe(16);
    expect(resolveFlattenSigma(1654, 2337)).toBe(Math.round(1654 / 16));
    expect(resolveFlattenSigma(2337, 1654)).toBe(Math.round(1654 / 16));
    // Never below sharp's smallest accepted sigma, however small the input.
    expect(resolveFlattenSigma(4, 4)).toBeGreaterThan(0);
  });

  it('returns a copy and leaves the source pixels byte-identical', async () => {
    const width = 64;
    const height = 64;
    const pixels = Buffer.alloc(width * height);
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = (index * 7) % 256;
    }
    const before = Buffer.from(pixels);

    const flattened = await flattenIllumination({ width, height, pixels });

    expect(flattened).not.toBe(pixels);
    expect(flattened.length).toBe(pixels.length);
    expect(pixels.equals(before)).toBe(true);
  });

  it('lifts a gradient-lit page back to a near-uniform paper level', async () => {
    const width = 320;
    const height = 480;
    const pixels = Buffer.allocUnsafe(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels[y * width + x] = Math.round(255 * (1 - 0.6 * (x / (width - 1))));
      }
    }

    const row = Math.floor(height / 2);
    const columns = [10, 80, 160, 240, 300];
    const rawSamples = columns.map((x) => pixels[row * width + x]);
    expect(Math.max(...rawSamples) - Math.min(...rawSamples)).toBeGreaterThan(100);

    const flattened = await flattenIllumination({ width, height, pixels });

    // One channel back, not three. sharp returns sRGB for a raw one-channel
    // input unless the colourspace is forced, and reading that as grayscale
    // leaves most of the lighting in the "background".
    expect(flattened.length).toBe(width * height);
    for (const x of columns) {
      expect(
        Math.abs(flattened[row * width + x] - FLATTEN_TARGET_PAPER_LEVEL),
        `column ${x} flattened to ${flattened[row * width + x]}`,
      ).toBeLessThanOrEqual(6);
    }
  });

  it('reuses the raw registration in the flattened copy instead of re-deriving it', async () => {
    const blank = await loadImageAnalysisData(cagiPath);
    const flattened = await buildFlattenedGeometryImage(blank);

    expect(flattened.contentBounds).toBe(blank.contentBounds);
    expect(flattened.pageBounds).toBe(blank.pageBounds);
    expect(flattened.contentBoundsSource).toBe(blank.contentBoundsSource);
    expect(flattened.contentBoundsConfident).toBe(blank.contentBoundsConfident);
    expect(flattened.width).toBe(blank.width);
    expect(flattened.height).toBe(blank.height);
    expect(flattened.pixels).not.toBe(blank.pixels);
  });
});

describe('two-stream grid selection', () => {
  it('computes no flattened copy when the sheet is not photo provenance', async () => {
    const image = makeImage();
    const buildFlattenedImage = vi.fn(async (input: ImageAnalysisData) => input);
    const build = vi.fn((_candidate: ImageAnalysisData) => detectionWithFields(3, 'raw'));

    const selection = await selectGridDetectionStream(image, build, false, { buildFlattenedImage });

    expect(buildFlattenedImage).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toBe(image);
    expect(selection.stream).toBe('raw');
    expect(selection.note).toBeUndefined();
    expect(selection.scoringImage).toBe(image);
  });

  it('keeps the flattened stream when it resolves more fields on a darkened sheet', async () => {
    for (const sheet of sheets) {
      const blank = await loadImageAnalysisData(sheet.filePath);
      const blankFields = Object.keys(sheet.build(blank).overrides).length;
      const darkened: ImageAnalysisData = { ...blank, pixels: await darkenWithGradient(blank, 0.7) };

      const rawFields = Object.keys(sheet.build(darkened).overrides).length;
      // The setup has to actually degrade the raw stream, or the rest of the
      // assertion proves nothing.
      expect(rawFields, `${sheet.name} darkening did not degrade the raw stream`).toBeLessThan(blankFields);

      const selection = await selectGridDetectionStream(darkened, sheet.build, true);
      const chosenFields = Object.keys(selection.detection.overrides).length;

      expect(selection.stream, `${sheet.name} raw=${rawFields} chosen=${chosenFields}`).toBe('flattened');
      expect(chosenFields).toBeGreaterThanOrEqual(rawFields);
      expect(selection.note).toBe(`grid-stream: flattened(${rawFields}->${chosenFields})`);
      // The chosen geometry is rects only; no pixel buffer rides along with it.
      expect(selection.scoringImage.pixels).toBe(darkened.pixels);
    }
  }, 60000);

  it('hands scoring the raw image and shows the flattened pixels only to the detector', async () => {
    const image = makeImage();
    const rawPixelsBefore = Buffer.from(image.pixels);
    const flattenedPixels = Buffer.alloc(image.pixels.length, 7);
    const buildFlattenedImage = vi.fn(async (input: ImageAnalysisData) => ({
      ...input,
      pixels: flattenedPixels,
    }));
    const build = vi.fn((candidate: ImageAnalysisData) => detectionWithFields(
      candidate.pixels === flattenedPixels ? 5 : 2,
      candidate.pixels === flattenedPixels ? 'flat' : 'raw',
    ));

    const selection = await selectGridDetectionStream(image, build, true, { buildFlattenedImage });

    expect(selection.stream).toBe('flattened');
    // The postcondition that matters: scoring gets the same object, holding
    // the same buffer, unmodified.
    expect(selection.scoringImage).toBe(image);
    expect(selection.scoringImage.pixels).toBe(image.pixels);
    expect(image.pixels.equals(rawPixelsBefore)).toBe(true);

    const [rawCall, flattenedCall] = build.mock.calls;
    expect(rawCall[0]).toBe(image);
    expect(flattenedCall[0]).not.toBe(image);
    expect(flattenedCall[0].pixels).toBe(flattenedPixels);
    expect(flattenedCall[0].contentBounds).toBe(image.contentBounds);
    expect(flattenedCall[0].width).toBe(image.width);
    expect(flattenedCall[0].height).toBe(image.height);
  });

  it('prefers the raw stream on a tie', async () => {
    const image = makeImage();
    const flattenedPixels = Buffer.alloc(image.pixels.length, 7);
    const rawDetection = detectionWithFields(3, 'raw');
    const flattenedDetection = detectionWithFields(3, 'flat');
    const buildFlattenedImage = vi.fn(async (input: ImageAnalysisData) => ({
      ...input,
      pixels: flattenedPixels,
    }));
    const build = vi.fn((candidate: ImageAnalysisData) => (
      candidate.pixels === flattenedPixels ? flattenedDetection : rawDetection
    ));

    const selection = await selectGridDetectionStream(image, build, true, { buildFlattenedImage });

    expect(build).toHaveBeenCalledTimes(2);
    expect(selection.stream).toBe('raw');
    expect(selection.detection).toBe(rawDetection);
    expect(selection.note).toBe('grid-stream: raw(3->3)');
  });

  it('falls back to the raw stream, and says so, when flattening fails', async () => {
    const image = makeImage();
    const rawDetection = detectionWithFields(3, 'raw');
    const buildFlattenedImage = vi.fn(async () => {
      throw new Error('flatten unavailable');
    });
    const build = vi.fn(() => rawDetection);

    const selection = await selectGridDetectionStream(image, build, true, { buildFlattenedImage });

    expect(selection.stream).toBe('raw');
    expect(selection.detection).toBe(rawDetection);
    expect(selection.note).toBe('grid-stream: raw(3->failed)');
    expect(selection.scoringImage).toBe(image);
  });
});

describe('grid-stream note on the recognition draft', () => {
  it('records the winning stream per sheet for photo provenance and nothing for a scan', async () => {
    const deadlines = { ocrDeadlineAt: Date.now(), digitOcrDeadlineAt: Date.now() };

    const scan = await recognizeStudentForms(cagiPath, satisfactionPath, deadlines);
    const scanKeys = Object.keys(scan.recognitionCropDiagnostic || {});
    expect(scanKeys.filter((key) => key.startsWith('sheet.'))).toEqual([]);

    const photo = await recognizeStudentForms(cagiPath, satisfactionPath, {
      ...deadlines,
      cagiPhotoProvenance: true,
      satisfactionPhotoProvenance: true,
    });
    const notePattern = /^grid-stream: (raw|flattened)\(\d+->(\d+|failed)\)$/;
    expect(photo.recognitionCropDiagnostic?.[GRID_STREAM_DIAGNOSTIC_KEY.cagi]).toMatch(notePattern);
    expect(photo.recognitionCropDiagnostic?.[GRID_STREAM_DIAGNOSTIC_KEY.satisfaction]).toMatch(notePattern);

    // Neither key is a recognition field, so nothing that renders the
    // diagnostics by field name can pick them up.
    expect(GRID_STREAM_DIAGNOSTIC_KEY.cagi.startsWith('sheet.')).toBe(true);
    expect(photo.confidence[GRID_STREAM_DIAGNOSTIC_KEY.cagi]).toBeUndefined();
  }, 60000);
});
