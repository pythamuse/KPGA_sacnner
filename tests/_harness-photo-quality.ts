/**
 * Labels every photo in a directory with what the shipped quad detector makes
 * of it: rectified or not, and on what numbers.
 *
 * Not a vitest file. The OpenCV build is a 10MB emscripten bundle, and vitest
 * sits at zero output indefinitely trying to put it through its transform
 * pipeline; plain Node requires it in 117ms. Bundle and run:
 *
 *   npx esbuild tests/_harness-photo-quality.ts --bundle --platform=node \
 *     --format=cjs --external:sharp --outfile=<scratch>/quality.cjs
 *   OPENCV_JS=<path> QUALITY_DIR=<dir> QUALITY_FORM=cagi node <scratch>/quality.cjs
 *
 * The detector itself is imported rather than re-implemented (see
 * detectDocumentQuad.ts), so this scores the code that ships. What differs from
 * the browser is the decode -- sharp here, Chrome there -- so validate the two
 * agree on a set already measured in the browser before trusting a new one.
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import sharp from 'sharp';
import { detectDocumentQuadFromMat } from '../src/lib/documentScanner/detectDocumentQuad';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';
import { orderQuadPoints } from '../src/lib/documentScanner/perspectiveCorrect';

const OPENCV_JS = process.env.OPENCV_JS;
const DIR = process.env.QUALITY_DIR;
const FORM = (process.env.QUALITY_FORM || 'cagi') as 'cagi' | 'satisfaction';
const DETECTION_DIMENSION = Number(process.env.QUALITY_DETECTION || 1600);
const MIN_CONFIDENCE = Number(process.env.QUALITY_MIN_CONFIDENCE || 0.58);
const WARP_DIR = process.env.QUALITY_WARP_DIR;
const WARP_SCALE = Number(process.env.QUALITY_WARP_SCALE || 3);
const SHOW_CANDIDATES = process.env.QUALITY_CANDIDATES === '1';
const OUT = process.env.PROBE_OUT || path.join(os.tmpdir(), 'photo-quality.json');

async function loadOpenCv(scriptPath: string): Promise<{ cv: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cv = require(scriptPath);
  // Poll rather than await `onRuntimeInitialized`: that hook does not fire
  // here, and awaiting a promise nothing settles leaves the loop empty, so
  // Node exits silently -- which reads exactly like a hang.
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  // Boxed, and it has to stay boxed. `cv` is an emscripten Module carrying its
  // own `then`, so returning it from an async function makes that promise adopt
  // it as a thenable and never settle -- the same trap that had the correction
  // worker timing out on every photo. It cost an hour here too.
  return { cv };
}

/** Same downscale the panel applies before handing the worker an ImageData. */
async function toDetectionImage(file: string, maxDimension: number) {
  const upright = await sharp(file).rotate().toBuffer({ resolveWithObject: true });
  const sourceWidth = upright.info.width;
  const sourceHeight = upright.info.height;
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const data = await sharp(upright.data).resize(width, height).ensureAlpha().raw().toBuffer();
  return { data, width, height, sourceWidth, sourceHeight };
}

/**
 * Warps at full source resolution, with the quad scaled up from the detection
 * canvas -- the same thing the Worker does. The encode differs (sharp here,
 * OffscreenCanvas there), so the bytes are not the browser's bytes; what this
 * is for is scoring the *geometry* decision on a set larger than a browser
 * round-trip per page allows.
 */
async function warpToFile(
  cv: any, file: string, quad: Array<{ x: number; y: number }>,
  detectionWidth: number, detectionHeight: number,
  outWidth: number, outHeight: number, destination: string,
) {
  const upright = await sharp(file).rotate().toBuffer({ resolveWithObject: true });
  const full = await sharp(upright.data).ensureAlpha().raw().toBuffer();
  const sx = upright.info.width / detectionWidth;
  const sy = upright.info.height / detectionHeight;
  const ordered = orderQuadPoints(quad.map((pt) => ({ x: pt.x * sx, y: pt.y * sy })));
  const source = cv.matFromArray(upright.info.height, upright.info.width, cv.CV_8UC4, full);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap((pt) => [pt.x, pt.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outWidth - 1, 0, outWidth - 1, outHeight - 1, 0, outHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(from, to);
  const result = new cv.Mat();
  try {
    cv.warpPerspective(source, result, transform, new cv.Size(outWidth, outHeight),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    await sharp(Buffer.from(result.data), { raw: { width: outWidth, height: outHeight, channels: 4 } })
      .jpeg({ quality: 88 }).toFile(destination);
  } finally {
    result.delete(); transform.delete(); to.delete(); from.delete(); source.delete();
  }
}

async function main() {
  if (!OPENCV_JS || !DIR) {
    throw new Error('OPENCV_JS and QUALITY_DIR are required.');
  }
  const { cv } = await loadOpenCv(OPENCV_JS);
  const template = FORM === 'cagi' ? cagiTemplate : satisfactionTemplate;
  const expectedAspectRatio = template.baseSize.height / template.baseSize.width;

  const files = fs.readdirSync(DIR)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));

  const rows: Array<Record<string, unknown>> = [];
  for (const file of files) {
    const image = await toDetectionImage(path.join(DIR, file), DETECTION_DIMENSION);
    const source = cv.matFromArray(image.height, image.width, cv.CV_8UC4, image.data);
    const candidates: Array<{ coverageW: number; coverageH: number; aspectRatio: number; marginMin: number; rejection: string | null; confidence: number | null }> = [];
    let detection: ReturnType<typeof detectDocumentQuadFromMat> = { quality: null, rejection: null };
    try {
      detection = detectDocumentQuadFromMat(cv, source, image.width, image.height, expectedAspectRatio,
        SHOW_CANDIDATES ? (c) => candidates.push(c) : undefined);
    } finally {
      source.delete();
    }
    const quality = detection.quality;

    const xs = quality?.points.map((p) => p.x) ?? [];
    const ys = quality?.points.map((p) => p.y) ?? [];
    const row = {
      file,
      form: FORM,
      source: `${image.sourceWidth}x${image.sourceHeight}`,
      rectified: Boolean(quality && quality.confidence >= MIN_CONFIDENCE),
      reason: !quality ? 'no-document'
        : quality.confidence < MIN_CONFIDENCE ? 'low-confidence' : null,
      rejection: detection.rejection,
      confidence: quality ? Number(quality.confidence.toFixed(3)) : 0,
      coverageW: quality ? Number(((Math.max(...xs) - Math.min(...xs)) / image.width).toFixed(3)) : null,
      coverageH: quality ? Number(((Math.max(...ys) - Math.min(...ys)) / image.height).toFixed(3)) : null,
      marginMin: quality ? Number(Math.min(
        Math.min(...xs) / image.width,
        1 - Math.max(...xs) / image.width,
        Math.min(...ys) / image.height,
        1 - Math.max(...ys) / image.height,
      ).toFixed(3)) : null,
      aspectRatio: quality ? Number(quality.aspectRatio.toFixed(3)) : null,
      edgeConsistency: quality ? Number(quality.edgeConsistency.toFixed(3)) : null,
      angleScore: quality ? Number(quality.angleScore.toFixed(3)) : null,
    };
    if (WARP_DIR) {
      fs.mkdirSync(WARP_DIR, { recursive: true });
      const destination = path.join(WARP_DIR, file.replace(/.[^.]+$/, '.jpg'));
      if (quality) {
        await warpToFile(cv, path.join(DIR, file), quality.points, image.width, image.height,
          template.baseSize.width * WARP_SCALE, template.baseSize.height * WARP_SCALE, destination);
      } else {
        // What the panel does today when correction refuses: upload unchanged.
        await sharp(path.join(DIR, file)).rotate().jpeg({ quality: 88 }).toFile(destination);
      }
    }
    rows.push(row);
    if (SHOW_CANDIDATES && !row.rectified) {
      const ranked = candidates
        .filter((c) => c.coverageW < 0.97 || c.coverageH < 0.97)
        .sort((a, b) => (b.coverageW * b.coverageH) - (a.coverageW * a.coverageH))
        .slice(0, 5);
      process.stdout.write(`      ${candidates.length} candidates; largest that is not the whole frame:
`);
      ranked.forEach((c) => process.stdout.write(
        `        cov ${c.coverageW.toFixed(3)}x${c.coverageH.toFixed(3)}`
        + `  ar ${c.aspectRatio.toFixed(3)}  margin ${c.marginMin.toFixed(3)}`
        + `  ${c.rejection ?? 'ACCEPTED'}
`));
    }
    process.stdout.write(`  ${row.file.padEnd(15)} ${row.rectified ? 'OK  ' : 'FAIL'}`
      + `  conf ${String(row.confidence).padEnd(6)}`
      + `  cov ${row.coverageW ?? '-'} x ${row.coverageH ?? '-'}`
      + `  ar ${row.aspectRatio ?? '-'}`
      + (row.reason ? `  ${row.reason}` : '') + '\n');
  }

  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2), 'utf8');
  const ok = rows.filter((r) => r.rectified).length;
  process.stdout.write(`rectified ${ok} / ${rows.length}  -> ${OUT}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).stack || error}\n`);
  process.exit(1);
});
