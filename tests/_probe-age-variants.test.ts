import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { createWorker, OEM, PSM } from 'tesseract.js';

/**
 * ONE-OFF PROBE -- delete after the round, OFFLINE
 * (Task/CYCLE3_AGE_OCR_PROBE_AGENT_REPORT_2026-09-05.md).
 *
 * Sweeps a grid of tesseract preprocessing variants over the `*-crop.png`
 * files `tests/_probe-age-crops.test.ts` dumps (the raw, native-resolution
 * age crop -- not the product's upscaled/binarized work image), and writes
 * one JSON line per (page, variant): `{page, variant:{scale, interp,
 * binarize, dilate, psm}, text, confidence}`. Only the whole-box reading is
 * swept -- the per-digit (SINGLE_CHAR) reading is what the product path
 * already does, and is not re-swept here.
 *
 * Starts from the same base worker config as the product's digit worker
 * (`getDigitWorker` in src/lib/recognition/ocrTextLines.ts): `eng` model,
 * the same lang/worker paths, `0123456789` whitelist, `user_defined_dpi`.
 * The whitelist is fixed, not swept -- it is not one of the axes below.
 *
 * Reads no answer key. Makes no judgement about which variant is better --
 * report only.
 *
 *   CROP_DIR="<probe-age-crops OUT dir>" OUT="<path to variants.jsonl>" \
 *     npx vitest run tests/_probe-age-variants.test.ts
 *
 * Full grid: scale {4,6,8,12} x interp {nearest,lanczos} x binarize
 * {none,otsu} x dilate {0,+1px,+2px} x psm {7,8,13} = 144 variants/page.
 * Override VARIANT_SCALES / VARIANT_PSMS (comma-separated) to shrink the
 * grid if the full sweep is too slow for the round it's run in -- see the
 * cycle report for the runtime actually measured.
 */

const CROP_DIR = process.env.CROP_DIR;
const OUT = process.env.OUT;

const SCALES = (process.env.VARIANT_SCALES || '4,6,8,12').split(',').map(Number);
const INTERPS: Array<'nearest' | 'lanczos'> = ['nearest', 'lanczos'];
const BINARIZE: Array<'none' | 'otsu'> = ['none', 'otsu'];
const DILATE = [0, 1, 2];
const PSMS = (process.env.VARIANT_PSMS || '7,8,13').split(',').map(Number);

const DIGIT_WHITELIST = '0123456789';
const PROBE_DPI = 300;
// Own cache dir -- distinct from the product's `DIGIT_OCR_CACHE_PATH` -- so
// this offline sweep never shares worker state with a real request.
const PROBE_CACHE_PATH = path.join(os.tmpdir(), 'gambling-prevention-probe-age-variants-cache');
const LANG_PATH = path.join(process.cwd(), 'src', 'lib', 'recognition', 'assets');
const WORKER_PATH = path.join(
  process.cwd(), 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js',
);

const PSM_BY_CODE: Record<number, PSM> = {
  7: PSM.SINGLE_LINE,
  8: PSM.SINGLE_WORD,
  13: PSM.RAW_LINE,
};

const run = CROP_DIR && OUT ? describe : describe.skip;

run('age variant sweep', () => {
  it('sweeps tesseract preprocessing variants over the dumped age crops', async () => {
    const cropFiles = fs.readdirSync(CROP_DIR!)
      .filter((name) => name.endsWith('-crop.png'))
      .sort();

    const worker = await createWorker('eng', OEM.DEFAULT, {
      cachePath: PROBE_CACHE_PATH,
      langPath: LANG_PATH,
      workerPath: WORKER_PATH,
      gzip: false,
    });
    await worker.setParameters({
      tessedit_char_whitelist: DIGIT_WHITELIST,
      preserve_interword_spaces: '0',
      user_defined_dpi: String(PROBE_DPI),
    });

    fs.mkdirSync(path.dirname(OUT!), { recursive: true });
    const outStream = fs.createWriteStream(OUT!, { flags: 'w' });

    const startedAt = Date.now();
    let variantCount = 0;
    // Avoid redundant `setParameters` round-trips: only call it again when
    // the PSM actually changes from the previous tesseract call.
    let lastPsm: number | undefined;

    for (const file of cropFiles) {
      const page = file.replace(/-crop\.png$/, '');
      const { data: pixels, info } = await sharp(path.join(CROP_DIR!, file))
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cropWidth = info.width;
      const cropHeight = info.height;

      for (const scale of SCALES) {
        const width = Math.max(1, Math.round(cropWidth * scale));
        const height = Math.max(1, Math.round(cropHeight * scale));

        for (const interp of INTERPS) {
          const kernel = interp === 'nearest' ? sharp.kernel.nearest : sharp.kernel.lanczos3;
          const { data: resized } = await sharp(pixels, {
            raw: { width: cropWidth, height: cropHeight, channels: 1 },
          })
            .resize({ width, height, fit: 'fill', kernel })
            .raw()
            .toBuffer({ resolveWithObject: true });

          for (const binarize of BINARIZE) {
            const base: Buffer = binarize === 'otsu'
              ? binarizeOtsu(resized, width, height)
              : Buffer.from(resized);

            for (const dilate of DILATE) {
              const pixelsForOcr = dilate === 0
                ? base
                : binarize === 'otsu'
                  ? dilateBinary(base, width, height, dilate)
                  : dilateGrayscaleInk(base, width, height, dilate);

              const png = await sharp(pixelsForOcr, { raw: { width, height, channels: 1 } })
                .png()
                .toBuffer();

              for (const psm of PSMS) {
                if (psm !== lastPsm) {
                  await worker.setParameters({ tessedit_pageseg_mode: PSM_BY_CODE[psm] });
                  lastPsm = psm;
                }
                const result = await worker.recognize(png, {}, { text: true });
                const text = typeof result.data.text === 'string'
                  ? result.data.text.replace(/\s/g, '')
                  : '';
                const confidence = Number.isFinite(result.data.confidence) ? result.data.confidence : 0;

                outStream.write(`${JSON.stringify({
                  page,
                  variant: { scale, interp, binarize, dilate, psm },
                  text,
                  confidence,
                })}\n`);
                variantCount++;
              }
            }
          }
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      outStream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    await worker.terminate();

    const elapsedMs = Date.now() - startedAt;
    const perPage = SCALES.length * INTERPS.length * BINARIZE.length * DILATE.length * PSMS.length;
    console.info(
      `[age-variants] pages=${cropFiles.length} variantsPerPage=${perPage} `
      + `totalLines=${variantCount} elapsedMs=${elapsedMs} out=${OUT}`,
    );
  }, 30 * 60_000);
});

/** Same Otsu split as the product's `otsuThreshold` in ocrTextLines.ts, reimplemented here so this probe has no import into that file's private helpers. */
function otsuThreshold(pixels: Buffer): number {
  const histogram = new Uint32Array(256);
  for (let index = 0; index < pixels.length; index++) {
    histogram[pixels[index]]++;
  }

  let weightedTotal = 0;
  for (let level = 0; level < 256; level++) {
    weightedTotal += level * histogram[level];
  }

  let darkWeight = 0;
  let darkWeightedSum = 0;
  let bestLevel = 0;
  let bestVariance = -1;

  for (let level = 0; level < 256; level++) {
    darkWeight += histogram[level];
    if (darkWeight === 0) continue;
    const lightWeight = pixels.length - darkWeight;
    if (lightWeight === 0) break;
    darkWeightedSum += level * histogram[level];
    const darkMean = darkWeightedSum / darkWeight;
    const lightMean = (weightedTotal - darkWeightedSum) / lightWeight;
    const variance = darkWeight * lightWeight * (darkMean - lightMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestLevel = level;
    }
  }

  return bestLevel;
}

function binarizeOtsu(pixels: Buffer, width: number, height: number): Buffer {
  const threshold = otsuThreshold(pixels);
  const out = Buffer.alloc(width * height);
  for (let index = 0; index < out.length; index++) {
    out[index] = pixels[index] <= threshold ? 0 : 255;
  }
  return out;
}

/** Binary dilation: a pixel becomes ink (0) if any pixel within a square `radius` is ink (0). */
function dilateBinary(pixels: Buffer, width: number, height: number, radius: number): Buffer {
  const out = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ink = false;
      for (let dy = -radius; dy <= radius && !ink; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const row = ny * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (pixels[row + nx] === 0) {
            ink = true;
            break;
          }
        }
      }
      out[y * width + x] = ink ? 0 : 255;
    }
  }
  return out;
}

/**
 * Grayscale analogue of dilation for the non-binarized variant: each pixel
 * takes the darkest (minimum) value within a square `radius`, which thickens
 * dark strokes without first committing to a hard ink/paper split.
 */
function dilateGrayscaleInk(pixels: Buffer, width: number, height: number, radius: number): Buffer {
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 255;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const row = ny * width;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const value = pixels[row + nx];
          if (value < min) min = value;
        }
      }
      out[y * width + x] = min;
    }
  }
  return out;
}
