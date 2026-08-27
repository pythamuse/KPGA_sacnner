/**
 * T5 harness: runs the SHIPPED registration pipeline over a directory of
 * photos, at product fidelity, and writes the warped output for accuracy
 * scoring against the answer key.
 *
 * Every decision-bearing function is imported from the product --
 * detectDocumentQuadFromMat, alignToTemplate, decideRegistration,
 * composeToFullRes, the committed template JSONs, the gate constants -- so
 * this measures the rule that ships, not a re-implementation of it
 * (CLAUDE.md §2: check what the instrument measures). Only the plumbing the
 * worker gets from the browser (ImageData, OffscreenCanvas) is replaced by
 * sharp + cv.Mat here.
 *
 * Not a vitest file: opencv.js hangs vitest's transform pipeline. Build and
 * run:
 *   npx esbuild tests/_harness-product-warp.ts --bundle --platform=node \
 *     --format=cjs --external:sharp --outfile=<scratch>/product-warp.cjs
 *   OPENCV_JS=... SRC_DIR=... OUT_DIR=... FORM=cagi REPORT=... node <scratch>/product-warp.cjs
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { detectDocumentQuadFromMat } from '../src/lib/documentScanner/detectDocumentQuad';
import { orderQuadPoints } from '../src/lib/documentScanner/perspectiveCorrect';
import {
  alignToTemplate,
  composeToFullRes,
  decideRegistration,
  multiplyHomographies,
  type OrbAlignment,
  type OrbTemplate,
} from '../src/lib/documentScanner/orbAlign';
import cagiOrbTemplate from '../src/lib/documentScanner/orbTemplate.cagi.json';
import satOrbTemplate from '../src/lib/documentScanner/orbTemplate.satisfaction.json';
import { cagiTemplate, satisfactionTemplate } from '../src/lib/recognition/roiTemplates';

const DETECTION_LONG_SIDE = 1600;      // worker constant
const MIN_CONFIDENCE = 0.58;           // client default minimumConfidence
const OUTPUT_SCALE = 3;                // PERSPECTIVE_CORRECTION_SCALE

async function loadOpenCv(scriptPath: string): Promise<{ cv: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cv = require(scriptPath);
  const startedAt = Date.now();
  // Poll: onRuntimeInitialized does not fire here, and `cv` is a thenable --
  // never let a promise resolve with it. Boxed on return.
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  return { cv };
}

/** Same construction as the worker's quadHomography helper. */
function quadHomographyToOutput(cv: any, points: Array<{ x: number; y: number }>, outW: number, outH: number): number[] {
  const [tl, tr, br, bl] = orderQuadPoints(points);
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1]);
  const transform = cv.getPerspectiveTransform(src, dst);
  const h = Array.from(transform.data64F as Float64Array);
  transform.delete(); dst.delete(); src.delete();
  return h;
}

async function main() {
  const { cv } = await loadOpenCv(process.env.OPENCV_JS!);
  const srcDir = process.env.SRC_DIR!;
  const outDir = process.env.OUT_DIR!;
  const form = (process.env.FORM || 'cagi') as 'cagi' | 'satisfaction';
  const orbTemplate = (form === 'cagi' ? cagiOrbTemplate : satOrbTemplate) as OrbTemplate;
  const roi = form === 'cagi' ? cagiTemplate : satisfactionTemplate;
  const outW = roi.baseSize.width * OUTPUT_SCALE;
  const outH = roi.baseSize.height * OUTPUT_SCALE;
  const expectedAspectRatio = roi.baseSize.height / roi.baseSize.width;

  fs.mkdirSync(outDir, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  const files = fs.readdirSync(srcDir).filter((f) => /\.jpe?g$/i.test(f))
    .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));

  for (const file of files) {
    const upright = await sharp(path.join(srcDir, file)).rotate().toBuffer();
    const meta = await sharp(upright).metadata();
    const fullW = meta.width!; const fullH = meta.height!;
    const fullBuf = await sharp(upright).ensureAlpha().raw().toBuffer();
    const sourceFull = cv.matFromArray(fullH, fullW, cv.CV_8UC4, fullBuf);

    const longSide = Math.max(fullW, fullH);
    const scale = longSide > DETECTION_LONG_SIDE ? DETECTION_LONG_SIDE / longSide : 1;
    const detW = Math.max(1, Math.round(fullW * scale));
    const detH = Math.max(1, Math.round(fullH * scale));
    const detection = new cv.Mat();
    cv.resize(sourceFull, detection, new cv.Size(detW, detH), 0, 0, cv.INTER_AREA);

    const { quality, rejection } = detectDocumentQuadFromMat(cv, detection, detW, detH, expectedAspectRatio);
    const quadAccepted = Boolean(quality && quality.confidence >= MIN_CONFIDENCE);

    let alignment: OrbAlignment | null = null;
    const gray = new cv.Mat();
    try {
      cv.cvtColor(detection, gray, cv.COLOR_RGBA2GRAY);
      alignment = alignToTemplate(cv, gray, orbTemplate);
    } finally {
      gray.delete();
    }

    let quadToOutput: number[] | null = null;
    let quadToTemplate: number[] | null = null;
    if (quadAccepted && quality) {
      quadToOutput = quadHomographyToOutput(cv, quality.points, outW, outH);
      quadToTemplate = multiplyHomographies(
        [orbTemplate.width / outW, 0, 0, 0, orbTemplate.height / outH, 0, 0, 0, 1],
        quadToOutput,
      );
    }

    const decision = decideRegistration({ quadAccepted, quadHomographyToTemplate: quadToTemplate, alignment });

    const destination = path.join(outDir, file);
    if (decision.method === 'none') {
      // Product-faithful pre-T4 behavior: the original passes through.
      await sharp(upright).jpeg({ quality: 90 }).toFile(destination);
    } else {
      const hToOutput = decision.method === 'quad'
        ? (quadToOutput as number[])
        : multiplyHomographies(
          [outW / orbTemplate.width, 0, 0, 0, outH / orbTemplate.height, 0, 0, 0, 1],
          (alignment as OrbAlignment).homography as number[],
        );
      const hFull = composeToFullRes(hToOutput, detW / fullW, detH / fullH);
      const hMat = cv.matFromArray(3, 3, cv.CV_64FC1, hFull);
      const out = new cv.Mat();
      cv.warpPerspective(sourceFull, out, hMat, new cv.Size(outW, outH),
        cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      await sharp(Buffer.from(out.data), { raw: { width: outW, height: outH, channels: 4 } })
        .jpeg({ quality: 88 }).toFile(destination);
      out.delete(); hMat.delete();
    }

    rows.push({
      file,
      method: decision.method,
      verified: decision.verified,
      quadConfidence: quality ? Number(quality.confidence.toFixed(3)) : 0,
      quadResidualPx: decision.quadResidualPx === null ? null : Number(decision.quadResidualPx.toFixed(1)),
      orbInliers: alignment?.inliers ?? 0,
      orbRatio: alignment ? Number(alignment.inlierRatio.toFixed(3)) : 0,
      rejection: quality ? null : rejection,
    });
    process.stdout.write(`${file.padEnd(15)} ${decision.method.padEnd(5)} verified=${decision.verified}`
      + ` conf=${quality ? quality.confidence.toFixed(2) : '-'}`
      + ` residual=${decision.quadResidualPx === null ? '-' : decision.quadResidualPx.toFixed(1)}`
      + ` inl=${alignment?.inliers ?? 0}\n`);

    detection.delete();
    sourceFull.delete();
  }

  fs.writeFileSync(process.env.REPORT!, JSON.stringify(rows, null, 1), 'utf8');
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).stack || error}\n`);
  process.exit(1);
});
