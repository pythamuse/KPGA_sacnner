#!/usr/bin/env node
/**
 * W3 stage 2 END-TO-END MEASUREMENT (Task/FEATURE_PLAN_2026-09-09.md §3,
 * Task/PHOTO_BATCH_ORDER_2026-09-09.md §3 item E): does one combined pick of
 * all 38 photos of a set come back as the right 19 pairs?
 *
 * The whole chain, offline: shuffle the 38 originals (seeded, so the run is
 * reproducible and does not depend on directory order) -> sort by capture time
 * with the SHIPPED `sortBatchImages`/`readCaptureTime` -> classify each photo
 * with the SHIPPED `alignToTemplate` against both templates on the SHIPPED
 * detection frame -> decide with the SHIPPED `decideFormSide` -> split with the
 * SHIPPED `splitBySide` -> pair front[i] with back[i] and compare against the
 * truth (cagi-pN pairs with sat-pN).
 *
 * This measures only. It tunes nothing and makes no go/no-go call (CLAUDE.md
 * §1.4: no self-pass). Nothing here is what the browser runs -- the raster is
 * sharp/node, not Chrome (CLAUDE.md §5.5: the two paths cannot be made equal).
 *
 *   OPENCV_JS=public/vendor/opencv/4.9.0/opencv.js \
 *     node scripts/check-form-split-e2e.cjs
 *
 * Env:
 *   OPENCV_JS   path to opencv.js (default public/vendor/opencv/4.9.0/opencv.js)
 *   PHOTO_ROOT  photo sample root (default C:/Users/night/Desktop/사진샘플)
 *   SETS        comma list of set names (default Set1,Set2,Set3)
 *   SEED        shuffle seed (default 20260909)
 *   OUT         JSONL output path (default .tmp/form-split-e2e.jsonl)
 *
 * The photos are student work: read in place, never copied into the repo
 * (CLAUDE.md §6). Only scores are written, and .tmp/ is gitignored.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, '.tmp');

/** perspectiveCorrect.worker.ts DETECTION_LONG_SIDE. */
const DETECTION_LONG_SIDE = 1600;
/** ImageUploadPanel.tsx FULL_RESOLUTION_DIMENSION -- the client's post cap. */
const FULL_RESOLUTION_DIMENSION = 4096;

const PHOTO_ROOT = process.env.PHOTO_ROOT || 'C:/Users/night/Desktop/사진샘플';
const SETS = (process.env.SETS || 'Set1,Set2,Set3').split(',').map((s) => s.trim()).filter(Boolean);
const SEED = Number(process.env.SEED || 20260909);
const OUT_PATH = path.resolve(ROOT, process.env.OUT || path.join('.tmp', 'form-split-e2e.jsonl'));

/** Folder name is the ground truth (plan §3). */
const TRUTH_FOLDERS = [
  { folder: '선별검사', truth: 'cagi' },
  { folder: '만족도', truth: 'satisfaction' },
];

const TEMPLATE_PATHS = {
  cagi: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.cagi.json'),
  satisfaction: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.satisfaction.json'),
};

function resolveOpenCvPath() {
  const candidate = process.env.OPENCV_JS || path.join('public', 'vendor', 'opencv', '4.9.0', 'opencv.js');
  const resolved = path.resolve(ROOT, candidate);
  if (!fs.existsSync(resolved)) throw new Error(`opencv.js not found at ${resolved}. Set OPENCV_JS.`);
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

/** Bundles a SHIPPED module for Node, so this scores shipped code, not a copy. */
function bundle(source, outName) {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  const outFile = path.join(BUNDLE_DIR, outName);
  execSync(
    `npx esbuild ${source} --bundle --platform=node --format=cjs --outfile="${outFile.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(outFile);
}

/**
 * Builds the detection-frame 8UC1 Mat the worker hands `alignToTemplate`.
 * Identical to scripts/check-orb-form-classify.cjs. Caller owns the Mat.
 */
async function toDetectionGray(cv, file) {
  // .rotate() with no argument applies EXIF orientation -- the browser's
  // createImageBitmap does this, sharp does not unless asked, and a 90-degree
  // difference would sink both alignments.
  const upright = await sharp(file).rotate().toBuffer();
  const meta = await sharp(upright).metadata();

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
  return gray;
}

/** mulberry32: deterministic, seeded, no dependency. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Student number from cagi-p7.jpg / sat-p7.jpg. */
function studentOf(filename) {
  const match = /p(\d+)/i.exec(filename);
  return match ? Number(match[1]) : null;
}

function pad(text, width, right = false) {
  const s = String(text);
  return right ? s.padStart(width) : s.padEnd(width);
}

(async () => {
  const uploadOrder = bundle('src/lib/uploadOrder.ts', 'uploadOrder-e2e.cjs');
  const formSplit = bundle('src/lib/formSplit.ts', 'formSplit-e2e.cjs');
  const orbAlign = bundle('src/lib/documentScanner/orbAlign.ts', 'orbAlign-e2e.cjs');
  const { cv } = await loadOpenCv(resolveOpenCvPath());

  const templates = {
    cagi: JSON.parse(fs.readFileSync(TEMPLATE_PATHS.cagi, 'utf8')),
    satisfaction: JSON.parse(fs.readFileSync(TEMPLATE_PATHS.satisfaction, 'utf8')),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const outStream = fs.createWriteStream(OUT_PATH, { flags: 'w' });

  console.log(`seed=${SEED}  photo root=${PHOTO_ROOT}`);
  const setSummaries = [];

  for (const set of SETS) {
    // ---- collect the set's 38 originals, then shuffle as one pick ---------
    const picked = [];
    for (const { folder, truth } of TRUTH_FOLDERS) {
      const dir = path.join(PHOTO_ROOT, set, folder);
      if (!fs.existsSync(dir)) throw new Error(`Missing photo folder: ${dir}`);
      for (const file of fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))) {
        picked.push({ set, folder, truth, file, fullPath: path.join(dir, file) });
      }
    }
    const random = makeRandom(SEED + set.length + set.charCodeAt(set.length - 1));
    const pick = shuffled(picked, random);

    // ---- A. capture-time sort, through the shipped tier logic -------------
    // Real File objects so `readCaptureTime` parses real EXIF bytes and
    // `sortBatchImages` runs its real key/tier comparison, not a re-write.
    const items = [];
    for (const job of pick) {
      const bytes = fs.readFileSync(job.fullPath);
      const stat = fs.statSync(job.fullPath);
      const file = new File([bytes], job.file, { type: 'image/jpeg', lastModified: stat.mtimeMs });
      items.push({ file, captureTime: await uploadOrder.readCaptureTime(file), job });
    }
    const ordered = uploadOrder.sortBatchImages(items);
    const withoutCaptureTime = ordered.filter((item) => item.captureTime == null).length;

    // ---- E. classify each photo, then decide ------------------------------
    const rows = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const { job, captureTime } = ordered[i];
      let gray = null;
      let scores = {
        cagi: { inliers: 0, goodMatches: 0, inlierRatio: 0 },
        satisfaction: { inliers: 0, goodMatches: 0, inlierRatio: 0 },
      };
      let error = null;
      try {
        gray = await toDetectionGray(cv, job.fullPath);
        for (const form of ['cagi', 'satisfaction']) {
          const alignment = orbAlign.alignToTemplate(cv, gray, templates[form]);
          scores[form] = {
            inliers: alignment.inliers,
            goodMatches: alignment.goodMatches,
            inlierRatio: Number(alignment.inlierRatio.toFixed(4)),
          };
        }
      } catch (err) {
        error = String(err && err.message ? err.message : err);
      } finally {
        if (gray) gray.delete();
      }

      const decision = formSplit.decideFormSide(scores);
      const row = {
        set,
        pickIndex: i + 1,
        file: job.file,
        truth: job.truth,
        student: studentOf(job.file),
        captureTime,
        scores,
        side: decision.side,
        bestInliers: decision.bestInliers,
        margin: Number(decision.margin.toFixed(3)),
        reason: decision.reason,
        error,
      };
      rows.push(row);
      outStream.write(`${JSON.stringify(row)}\n`);
    }

    // ---- split and pair ---------------------------------------------------
    const split = formSplit.splitBySide(rows);
    const undecided = rows.filter((r) => r.side === null);
    const misclassified = rows.filter((r) => r.side !== null && r.side !== r.truth);

    const pairCount = Math.min(split.cagi.length, split.satisfaction.length);
    const wrongPairs = [];
    let correctPairs = 0;
    for (let i = 0; i < pairCount; i += 1) {
      const front = split.cagi[i];
      const back = split.satisfaction[i];
      const ok = front.truth === 'cagi'
        && back.truth === 'satisfaction'
        && front.student != null
        && front.student === back.student;
      if (ok) correctPairs += 1;
      else wrongPairs.push({ index: i + 1, front: front.file, back: back.file });
    }

    setSummaries.push({
      set,
      photos: rows.length,
      withoutCaptureTime,
      front: split.cagi.length,
      back: split.satisfaction.length,
      undecided: undecided.length,
      misclassified: misclassified.length,
      ready: split.ready,
      pairCount,
      correctPairs,
      wrongPairs,
      minMargin: Math.min(...rows.filter((r) => r.side !== null).map((r) => r.margin)),
      minBestInliers: Math.min(...rows.filter((r) => r.side !== null).map((r) => r.bestInliers)),
    });

    console.log(
      `\n${set}: ${rows.length} photos -> front ${split.cagi.length} / back ${split.satisfaction.length}` +
      `  undecided ${undecided.length}  registerable=${split.ready}` +
      `  pairs correct ${correctPairs}/${pairCount}`,
    );
    for (const row of misclassified) {
      console.log(`  MISCLASSIFIED  ${row.file}  truth=${row.truth} -> ${row.side}` +
        `  cagi=${row.scores.cagi.inliers} sat=${row.scores.satisfaction.inliers} margin=${row.margin}`);
    }
    for (const row of undecided) {
      console.log(`  UNDECIDED      ${row.file}  truth=${row.truth}  reason=${row.reason}` +
        `  cagi=${row.scores.cagi.inliers} sat=${row.scores.satisfaction.inliers} margin=${row.margin}` +
        `${row.error ? `  error=${row.error}` : ''}`);
    }
    for (const wrong of wrongPairs) {
      console.log(`  WRONG PAIR     #${wrong.index}: front ${wrong.front} + back ${wrong.back}`);
    }
  }

  await new Promise((resolve) => outStream.end(resolve));

  const line = '='.repeat(88);
  console.log(`\n${line}\nSUMMARY  (one combined pick per set, shuffled with seed ${SEED})\n${line}`);
  console.log(
    `${pad('set', 8)}${pad('photos', 8, true)}${pad('front', 7, true)}${pad('back', 7, true)}` +
    `${pad('undec', 7, true)}${pad('misclass', 10, true)}${pad('pairs ok', 10, true)}` +
    `${pad('minMargin', 11, true)}${pad('minBest', 9, true)}`,
  );
  for (const s of setSummaries) {
    console.log(
      `${pad(s.set, 8)}${pad(s.photos, 8, true)}${pad(s.front, 7, true)}${pad(s.back, 7, true)}` +
      `${pad(s.undecided, 7, true)}${pad(s.misclassified, 10, true)}` +
      `${pad(`${s.correctPairs}/${s.pairCount}`, 10, true)}` +
      `${pad(Number.isFinite(s.minMargin) ? s.minMargin.toFixed(2) : 'n/a', 11, true)}` +
      `${pad(Number.isFinite(s.minBestInliers) ? s.minBestInliers : 'n/a', 9, true)}`,
    );
  }
  const totalWrong = setSummaries.reduce((sum, s) => sum + s.wrongPairs.length, 0);
  console.log(`\nWrong pairs across all sets: ${totalWrong}`);
  console.log(`Photos with no EXIF capture time: ${setSummaries.reduce((n, s) => n + s.withoutCaptureTime, 0)}`);
  console.log(`\nJSONL: ${OUT_PATH}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
