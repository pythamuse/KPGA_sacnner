#!/usr/bin/env node
/**
 * W3 stage 1 MEASUREMENT (Task/FEATURE_PLAN_2026-09-09.md §3): can a raw phone
 * photo's form type (front = cagi, back = satisfaction) be decided by aligning
 * it against BOTH committed ORB templates and comparing match quality?
 *
 * This measures only. It tunes nothing, changes no product code, and makes no
 * go/no-go call -- the main agent judges (CLAUDE.md §1.4: no self-pass).
 *
 * Standalone Node on purpose: vitest hangs transforming the 10MB opencv.js
 * bundle, so anything needing cv runs as a plain script (same rule as
 * scripts/check-orb-align.cjs and tests/_harness-photo-quality.ts).
 *
 *   OPENCV_JS=public/vendor/opencv/4.9.0/opencv.js \
 *     node scripts/check-orb-form-classify.cjs
 *
 * Product fidelity: the detection frame is built exactly as
 * perspectiveCorrect.worker.ts builds it (EXIF-upright -> RGBA ->
 * resize INTER_AREA to long side 1600 -> COLOR_RGBA2GRAY), and the matcher is
 * the shipped alignToTemplate, called once per template. Nothing is
 * re-implemented.
 *
 * Env:
 *   OPENCV_JS   path to opencv.js (default public/vendor/opencv/4.9.0/opencv.js)
 *   PHOTO_ROOT  photo sample root (default C:/Users/night/Desktop/사진샘플)
 *   SETS        comma list of set names (default Set1,Set2,Set3)
 *   OUT         JSONL output path (default .tmp/orb-form-classify.jsonl)
 *
 * The photos are student work: they are read in place and never copied into
 * the repo (CLAUDE.md §6). Only scores are written, and .tmp/ is gitignored.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, '.tmp');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'orbAlign-classify.cjs');

/** perspectiveCorrect.worker.ts DETECTION_LONG_SIDE. */
const DETECTION_LONG_SIDE = 1600;
/** ImageUploadPanel.tsx FULL_RESOLUTION_DIMENSION -- the client's post cap. */
const FULL_RESOLUTION_DIMENSION = 4096;

const PHOTO_ROOT = process.env.PHOTO_ROOT || 'C:/Users/night/Desktop/사진샘플';
const SETS = (process.env.SETS || 'Set1,Set2,Set3').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_PATH = path.resolve(ROOT, process.env.OUT || path.join('.tmp', 'orb-form-classify.jsonl'));

/** Folder name is the ground truth (plan §3). */
const TRUTH_FOLDERS = [
  { folder: '선별검사', truth: 'cagi' },
  { folder: '만족도', truth: 'satisfaction' },
];

const FORMS = [
  { name: 'cagi', template: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.cagi.json') },
  { name: 'satisfaction', template: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.satisfaction.json') },
];

function resolveOpenCvPath() {
  const candidate = process.env.OPENCV_JS || path.join('public', 'vendor', 'opencv', '4.9.0', 'opencv.js');
  const resolved = path.resolve(ROOT, candidate);
  if (!fs.existsSync(resolved)) {
    throw new Error(`opencv.js not found at ${resolved}. Set OPENCV_JS.`);
  }
  return resolved;
}

async function loadOpenCv(scriptPath) {
  const cv = require(scriptPath);
  // Poll instead of awaiting onRuntimeInitialized: the hook does not fire
  // reliably in Node, and the pending setTimeout keeps the event loop alive.
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  // Boxed -- cv is a thenable emscripten Module; never resolve a promise with it.
  return { cv };
}

/** Bundles the SHIPPED orbAlign.ts for Node, so this scores the shipped matcher. */
function loadOrbAlign() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  execSync(
    'npx esbuild src/lib/documentScanner/orbAlign.ts --bundle --platform=node ' +
    `--format=cjs --outfile="${BUNDLE_PATH.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(BUNDLE_PATH);
}

/**
 * Builds the detection-frame 8UC1 Mat the worker would hand alignToTemplate.
 * Caller owns the returned Mat.
 */
async function toDetectionGray(cv, file) {
  // .rotate() with no argument applies EXIF orientation -- the browser's
  // createImageBitmap does this, sharp does not unless asked, and a 90-degree
  // difference would sink both alignments.
  let pipeline = sharp(file).rotate();
  const upright = await pipeline.toBuffer();
  const meta = await sharp(upright).metadata();

  // Client cap before posting to the worker (FULL_RESOLUTION_DIMENSION).
  let sourceBuf = upright;
  let fullW = meta.width;
  let fullH = meta.height;
  if (Math.max(fullW, fullH) > FULL_RESOLUTION_DIMENSION) {
    sourceBuf = await sharp(upright)
      .resize(FULL_RESOLUTION_DIMENSION, FULL_RESOLUTION_DIMENSION, { fit: 'inside' })
      .toBuffer();
    const capped = await sharp(sourceBuf).metadata();
    fullW = capped.width;
    fullH = capped.height;
  }

  const rgba = await sharp(sourceBuf).ensureAlpha().raw().toBuffer();
  const sourceFull = cv.matFromArray(fullH, fullW, cv.CV_8UC4, rgba);

  const longSide = Math.max(fullW, fullH);
  const scale = longSide > DETECTION_LONG_SIDE ? DETECTION_LONG_SIDE / longSide : 1;
  const detW = Math.max(1, Math.round(fullW * scale));
  const detH = Math.max(1, Math.round(fullH * scale));

  const detection = new cv.Mat();
  const gray = new cv.Mat();
  try {
    cv.resize(sourceFull, detection, new cv.Size(detW, detH), 0, 0, cv.INTER_AREA);
    cv.cvtColor(detection, gray, cv.COLOR_RGBA2GRAY);
  } catch (error) {
    gray.delete();
    detection.delete();
    sourceFull.delete();
    throw error;
  }
  detection.delete();
  sourceFull.delete();
  return { gray, fullW, fullH, detW, detH };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return 'Inf';
  return value.toFixed(digits);
}

function pad(text, width, right = false) {
  const s = String(text);
  // Korean folder/file names are wide; this table only pads ASCII columns.
  return right ? s.padStart(width) : s.padEnd(width);
}

(async () => {
  const orbAlign = loadOrbAlign();
  const { cv } = await loadOpenCv(resolveOpenCvPath());

  const templates = {};
  for (const form of FORMS) {
    templates[form.name] = JSON.parse(fs.readFileSync(form.template, 'utf8'));
  }

  const jobs = [];
  for (const set of SETS) {
    for (const { folder, truth } of TRUTH_FOLDERS) {
      const dir = path.join(PHOTO_ROOT, set, folder);
      if (!fs.existsSync(dir)) {
        throw new Error(`Missing photo folder: ${dir}`);
      }
      const files = fs.readdirSync(dir)
        .filter((f) => /\.(jpe?g|png)$/i.test(f))
        .sort((a, b) => Number(/([0-9]+)/.exec(a)?.[1] ?? 0) - Number(/([0-9]+)/.exec(b)?.[1] ?? 0));
      // LIMIT caps photos per folder -- smoke-test lever only; the reported
      // round runs unlimited.
      const limit = process.env.LIMIT ? Number(process.env.LIMIT) : files.length;
      for (const file of files.slice(0, limit)) {
        jobs.push({ set, folder, truth, file, fullPath: path.join(dir, file) });
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const outStream = fs.createWriteStream(OUT_PATH, { flags: 'w' });

  const rows = [];
  const alignMs = [];
  const prepMs = [];

  for (const job of jobs) {
    const row = {
      set: job.set,
      folder: job.folder,
      file: job.file,
      truth: job.truth,
      scores: {},
    };

    let gray = null;
    try {
      const prepStart = Date.now();
      const prepared = await toDetectionGray(cv, job.fullPath);
      prepMs.push(Date.now() - prepStart);
      gray = prepared.gray;
      row.fullWidth = prepared.fullW;
      row.fullHeight = prepared.fullH;
      row.detectionWidth = prepared.detW;
      row.detectionHeight = prepared.detH;

      for (const form of FORMS) {
        const startedAt = Date.now();
        const alignment = orbAlign.alignToTemplate(cv, gray, templates[form.name]);
        const elapsed = Date.now() - startedAt;
        alignMs.push(elapsed);

        const aligned = Boolean(alignment.homography);
        row.scores[form.name] = {
          aligned,
          inliers: alignment.inliers,
          goodMatches: alignment.goodMatches,
          inlierRatio: Number(alignment.inlierRatio.toFixed(4)),
          // The only alignment-quality scalar orbAlign exposes beyond the
          // counts: median |H(photoPt) - templatePt| over its own inliers, in
          // template-frame px. Low by construction for the winning template
          // (RANSAC selected these pairs), so it is recorded, not primary.
          selfResidualPx: aligned && alignment.inlierPairs.length > 0
            ? Number(orbAlign.measureResidualPx(alignment.homography, alignment.inlierPairs).toFixed(3))
            : null,
          elapsedMs: elapsed,
        };
      }
    } catch (error) {
      row.error = String(error && error.message ? error.message : error);
    } finally {
      if (gray) gray.delete();
    }

    const cagi = row.scores.cagi;
    const sat = row.scores.satisfaction;

    if (row.error || !cagi || !sat) {
      row.predicted = 'unclassified';
      row.reason = row.error ? 'error' : 'missing-score';
    } else if (!cagi.aligned && !sat.aligned) {
      row.predicted = 'unclassified';
      row.reason = 'no-homography-either-template';
    } else if (cagi.inliers === sat.inliers) {
      row.predicted = 'unclassified';
      row.reason = 'tie';
    } else {
      row.predicted = cagi.inliers > sat.inliers ? 'cagi' : 'satisfaction';
      row.reason = null;
    }

    if (row.predicted !== 'unclassified') {
      const best = Math.max(cagi.inliers, sat.inliers);
      const second = Math.min(cagi.inliers, sat.inliers);
      row.bestInliers = best;
      row.secondInliers = second;
      row.margin = second === 0 ? Infinity : best / second;
      row.marginRatioScore = (() => {
        const a = cagi.inlierRatio;
        const b = sat.inlierRatio;
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        return lo === 0 ? Infinity : hi / lo;
      })();
      row.correct = row.predicted === row.truth;
    } else {
      row.bestInliers = null;
      row.secondInliers = null;
      row.margin = null;
      row.marginRatioScore = null;
      row.correct = false;
    }

    rows.push(row);
    outStream.write(`${JSON.stringify(row, (key, value) => (value === Infinity ? 'Infinity' : value))}\n`);

    const c = cagi ? `${cagi.inliers}/${cagi.goodMatches} r=${fmt(cagi.inlierRatio, 3)}` : 'err';
    const s = sat ? `${sat.inliers}/${sat.goodMatches} r=${fmt(sat.inlierRatio, 3)}` : 'err';
    process.stdout.write(
      `${job.set} ${job.folder}/${job.file}  truth=${job.truth}  cagi[${c}]  sat[${s}]  ` +
      `-> ${row.predicted}${row.predicted !== 'unclassified' && !row.correct ? '  *** WRONG' : ''}\n`,
    );
  }

  await new Promise((resolve) => outStream.end(resolve));

  // ---------------------------------------------------------------- summary
  const line = '='.repeat(78);
  console.log(`\n${line}\nSUMMARY  (primary score = ORB inlier count; predicted = template with more inliers)\n${line}`);

  const groups = [];
  for (const set of SETS) groups.push({ label: set, rows: rows.filter((r) => r.set === set) });
  groups.push({ label: 'OVERALL', rows });

  console.log('\nConfusion (rows = truth, cols = predicted)');
  console.log(`${pad('set', 9)}${pad('truth', 14)}${pad('->cagi', 9, true)}${pad('->sat', 9, true)}${pad('->uncl', 9, true)}${pad('n', 6, true)}`);
  for (const group of groups) {
    for (const truth of ['cagi', 'satisfaction']) {
      const subset = group.rows.filter((r) => r.truth === truth);
      const toCagi = subset.filter((r) => r.predicted === 'cagi').length;
      const toSat = subset.filter((r) => r.predicted === 'satisfaction').length;
      const uncl = subset.filter((r) => r.predicted === 'unclassified').length;
      console.log(
        `${pad(group.label, 9)}${pad(truth, 14)}${pad(toCagi, 9, true)}${pad(toSat, 9, true)}${pad(uncl, 9, true)}${pad(subset.length, 6, true)}`,
      );
    }
  }

  console.log('\nAccuracy');
  console.log(`${pad('set', 9)}${pad('correct', 10, true)}${pad('wrong', 8, true)}${pad('uncl', 7, true)}${pad('n', 6, true)}`);
  for (const group of groups) {
    const correct = group.rows.filter((r) => r.correct).length;
    const wrong = group.rows.filter((r) => r.predicted !== 'unclassified' && !r.correct).length;
    const uncl = group.rows.filter((r) => r.predicted === 'unclassified').length;
    console.log(
      `${pad(group.label, 9)}${pad(correct, 10, true)}${pad(wrong, 8, true)}${pad(uncl, 7, true)}${pad(group.rows.length, 6, true)}`,
    );
  }

  console.log('\nMargin = best/second-best inlier count (Inf when second-best is 0)');
  console.log(`${pad('group', 22)}${pad('n', 6, true)}${pad('min', 10, true)}${pad('p05', 10, true)}${pad('median', 10, true)}`);
  const marginGroups = [
    { label: 'correct (all sets)', rows: rows.filter((r) => r.correct) },
    { label: 'incorrect', rows: rows.filter((r) => r.predicted !== 'unclassified' && !r.correct) },
  ];
  for (const set of SETS) {
    marginGroups.push({ label: `correct ${set}`, rows: rows.filter((r) => r.set === set && r.correct) });
  }
  for (const group of marginGroups) {
    const values = group.rows.map((r) => r.margin).filter((v) => v !== null && v !== undefined);
    const sorted = [...values].sort((a, b) => a - b);
    console.log(
      `${pad(group.label, 22)}${pad(sorted.length, 6, true)}${pad(fmt(sorted[0]), 10, true)}` +
      `${pad(fmt(percentile(sorted, 0.05)), 10, true)}${pad(fmt(median(sorted)), 10, true)}`,
    );
  }

  console.log('\nInlier-ratio margin (recorded alternative, not the decision axis)');
  console.log(`${pad('group', 22)}${pad('n', 6, true)}${pad('min', 10, true)}${pad('p05', 10, true)}${pad('median', 10, true)}`);
  for (const group of marginGroups) {
    const values = group.rows.map((r) => r.marginRatioScore).filter((v) => v !== null && v !== undefined);
    const sorted = [...values].sort((a, b) => a - b);
    console.log(
      `${pad(group.label, 22)}${pad(sorted.length, 6, true)}${pad(fmt(sorted[0]), 10, true)}` +
      `${pad(fmt(percentile(sorted, 0.05)), 10, true)}${pad(fmt(median(sorted)), 10, true)}`,
    );
  }

  console.log('\nRaw score spread (winning vs losing template, all classified photos)');
  console.log(`${pad('quantity', 30)}${pad('min', 10, true)}${pad('p05', 10, true)}${pad('median', 10, true)}`);
  const classified = rows.filter((r) => r.predicted !== 'unclassified');
  const spreads = [
    ['best inliers', classified.map((r) => r.bestInliers)],
    ['second-best inliers', classified.map((r) => r.secondInliers)],
    ['winner inlier ratio', classified.map((r) => r.scores[r.predicted].inlierRatio)],
    ['loser inlier ratio', classified.map((r) => r.scores[r.predicted === 'cagi' ? 'satisfaction' : 'cagi'].inlierRatio)],
    ['winner selfResidualPx', classified.map((r) => r.scores[r.predicted].selfResidualPx).filter((v) => v !== null)],
  ];
  for (const [label, values] of spreads) {
    const sorted = [...values].sort((a, b) => a - b);
    console.log(
      `${pad(label, 30)}${pad(fmt(sorted[0], 3), 10, true)}${pad(fmt(percentile(sorted, 0.05), 3), 10, true)}${pad(fmt(median(sorted), 3), 10, true)}`,
    );
  }

  const misses = rows.filter((r) => r.predicted === 'unclassified' || !r.correct);
  console.log(`\nMisclassified or unclassified: ${misses.length}`);
  for (const row of misses) {
    const c = row.scores.cagi;
    const s = row.scores.satisfaction;
    console.log(
      `  ${row.set} ${row.folder}/${row.file}  truth=${row.truth} predicted=${row.predicted}` +
      `${row.reason ? ` (${row.reason})` : ''}  ` +
      `cagi inliers=${c ? c.inliers : 'err'} good=${c ? c.goodMatches : 'err'} ratio=${c ? fmt(c.inlierRatio, 3) : 'err'}  ` +
      `sat inliers=${s ? s.inliers : 'err'} good=${s ? s.goodMatches : 'err'} ratio=${s ? fmt(s.inlierRatio, 3) : 'err'}`,
    );
  }

  console.log('\nTiming');
  console.log(`  median ms per alignToTemplate call (one photo, one template): ${fmt(median(alignMs), 0)}`);
  console.log(`  median ms decode+detection-frame prep per photo:              ${fmt(median(prepMs), 0)}`);
  console.log(`  median ms per photo, both templates (prep + 2 aligns):        ${fmt(median(prepMs) + 2 * median(alignMs), 0)}`);
  console.log(`  photos: ${rows.length}   align calls: ${alignMs.length}`);
  console.log(`\nJSONL: ${OUT_PATH}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
