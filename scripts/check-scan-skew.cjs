#!/usr/bin/env node
/**
 * Does small geometric skew explain the scan sets' recognition spread?
 *
 * The user's claim: even a slightly tilted scan loses cells, which would be a
 * serious defect. CLAUDE.md §5.5 closed "coordinate/page geometry is not the
 * bottleneck" -- but that closure was judged on SET 1 ALONE, and reopening it
 * requires new evidence. Three sets of the same sheets are that evidence
 * opportunity: same ink, same students, different feeds through the scanner.
 *
 * MEASURES, per page per set per form:
 *   - ORB homography against the committed blank template (the same registration
 *     the photo path ships), decomposed into rotation deg, scale, translation,
 *     and a perspective magnitude
 *   - alignment health (inliers, ratio)
 *
 * The caller then joins this to the per-page CORRECT/BLANK/OFF/MISSING numbers
 * from tests/real-scan-measure.test.ts and scores the correlation against a
 * shuffled-label control.
 *
 * FALSIFIABLE PREDICTION, written before running (§2): if |rotation| or shift
 * does not separate high-blank pages from low-blank pages better than the
 * shuffled-label p95, the skew hypothesis is dead and §5.5 stays closed.
 *
 *   node scripts/check-scan-skew.cjs "<cagi.pdf>" "<sat.pdf>" <setNo> <out.jsonl> [reverseSat]
 *
 * OpenCV.js: cached copy in the OS temp dir (see check-orb-align.cjs).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
const BUNDLE_DIR = path.join(ROOT, '.tmp');
const ORB_BUNDLE = path.join(BUNDLE_DIR, 'orbAlign.cjs');

const [CAGI_PDF, SAT_PDF, SET_NO, OUT, REVERSE_SAT] = process.argv.slice(2);
if (!CAGI_PDF || !SAT_PDF || !SET_NO || !OUT) {
  console.error('usage: node scripts/check-scan-skew.cjs <cagi.pdf> <sat.pdf> <set> <out.jsonl> [reverseSat]');
  process.exit(1);
}
const PAGES = 19;
// Production first rung -- what the browser uploads and what the measurement
// harness renders (tests/real-scan-measure.test.ts).
const RENDER_SCALE = 1.5;
const RENDER_QUALITY = 0.86;

async function loadOpenCv() {
  const cached = path.join(os.tmpdir(), 'opencv-4.9.0.js');
  if (!fs.existsSync(cached) || fs.statSync(cached).size < 5_000_000) {
    throw new Error('opencv.js cache missing -- run scripts/check-orb-align.cjs once first');
  }
  const cv = require(cached);
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  return { cv }; // boxed -- cv is a thenable emscripten Module
}

function loadOrbAlign() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  execSync(
    'npx esbuild src/lib/documentScanner/orbAlign.ts --bundle --platform=node ' +
    `--format=cjs --outfile="${ORB_BUNDLE.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(ORB_BUNDLE);
}

async function renderPdfPages(pdfPath, pages, outDir, label) {
  const { createCanvas, Image, ImageData } = require('canvas');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  class NodeCanvasFactory {
    create(width, height) {
      const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(cc, width, height) {
      cc.canvas.width = Math.max(1, width);
      cc.canvas.height = Math.max(1, height);
    }
    destroy(cc) { cc.canvas = null; cc.context = null; }
  }
  const g = globalThis;
  g.ImageData = g.ImageData || ImageData;
  g.Image = g.Image || Image;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    isEvalSupported: false,
    useSystemFonts: true,
    CanvasFactory: NodeCanvasFactory,
  }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(pages, doc.numPages); n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const file = path.join(outDir, `${label}-p${n}.jpg`);
    fs.writeFileSync(file, canvas.toBuffer('image/jpeg', { quality: RENDER_QUALITY }));
    out.push(file);
  }
  return out;
}

/**
 * Decompose a 3x3 homography (row-major, h22-normalised) into interpretable
 * terms. Rotation and scale come from the affine 2x2 via polar decomposition of
 * the first column; perspective magnitude is |h20| + |h21| scaled by image size
 * so it reads roughly as "pixels of warp across the page".
 */
function decompose(h, width, height) {
  const n = h[8] !== 0 ? h.map((v) => v / h[8]) : [...h];
  const rotationDeg = (Math.atan2(n[3], n[0]) * 180) / Math.PI;
  const scaleX = Math.hypot(n[0], n[3]);
  const scaleY = Math.hypot(n[1], n[4]);
  const perspectivePx = (Math.abs(n[6]) * width + Math.abs(n[7]) * height) * Math.max(width, height);
  return {
    rotationDeg: Number(rotationDeg.toFixed(4)),
    scaleX: Number(scaleX.toFixed(5)),
    scaleY: Number(scaleY.toFixed(5)),
    translateX: Number(n[2].toFixed(2)),
    translateY: Number(n[5].toFixed(2)),
    perspectivePx: Number(perspectivePx.toFixed(2)),
  };
}

async function measurePage(cv, orbAlign, template, file) {
  const meta = await sharp(file).metadata();
  // ORB template descriptors live at template.width x height; feed the scan at
  // its native render size -- alignToTemplate matches descriptors, and the
  // homography's scale terms then carry the size ratio, which is fine because
  // rotation and perspective are what this probe reads.
  const raw = await sharp(file).grayscale().raw().toBuffer();
  const gray = cv.matFromArray(meta.height, meta.width, cv.CV_8UC1, raw);
  try {
    const alignment = orbAlign.alignToTemplate(cv, gray, template);
    if (!alignment.homography) {
      return { aligned: false, inliers: alignment.inliers, ratio: alignment.inlierRatio };
    }
    return {
      aligned: true,
      inliers: alignment.inliers,
      ratio: Number(alignment.inlierRatio.toFixed(3)),
      ...decompose(alignment.homography, meta.width, meta.height),
    };
  } finally {
    gray.delete();
  }
}

(async () => {
  const { cv } = await loadOpenCv();
  const orbAlign = loadOrbAlign();
  const forms = [
    {
      key: 'cagi',
      pdf: CAGI_PDF,
      template: JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.cagi.json'), 'utf8')),
    },
    {
      key: 'sat',
      pdf: SAT_PDF,
      template: JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.satisfaction.json'), 'utf8')),
    },
  ];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kpga-skew-'));
  const rows = [];
  for (const form of forms) {
    const files = await renderPdfPages(form.pdf, PAGES, tmp, form.key);
    const ordered = form.key === 'sat' && REVERSE_SAT ? [...files].reverse() : files;
    for (let i = 0; i < ordered.length; i += 1) {
      const student = i + 1;
      const m = await measurePage(cv, orbAlign, form.template, ordered[i]);
      rows.push({ set: Number(SET_NO), form: form.key, student, ...m });
      process.stderr.write(`set${SET_NO} ${form.key} p${student} rot=${m.rotationDeg ?? '?'} inl=${m.inliers}\n`);
    }
  }
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n'));
  console.log(`wrote ${rows.length} rows -> ${OUT}`);
})();
