#!/usr/bin/env node
/**
 * CAPTURE_GUIDANCE §8-1: what does ONE live guidance detection cost?
 *
 *   node scripts/check-live-detect-cost.cjs
 *
 * §7 proposes a 480px long side and "4 fps or better" and says outright that
 * both are targets, not measurements. This is the measurement of the first
 * half: `detectDocumentQuadFromMat` -- the only thing the worker's `detect`
 * path runs -- timed N times on a frame of that size.
 *
 * Standalone Node on purpose: vitest hangs trying to transform the 10MB
 * opencv.js bundle, so anything needing `cv` runs as a plain script (same rule
 * as scripts/check-orb-align.cjs).
 *
 * WHAT THIS DOES NOT MEASURE, and do not let it be quoted as if it did:
 *   - It is not an fps number. It excludes the video grab, the canvas
 *     downscale, the structured-clone/transfer to the worker, and React's
 *     re-render. It is the detector alone.
 *   - The frame is SYNTHETIC (blank form warped onto a noisy grey background).
 *     Detection cost scales with how many contours the four detection maps
 *     produce, and a real desk photo produces more. Treat this as a floor for
 *     a clean scene, not as the cost on a user's kitchen table. CLAUDE.md §2:
 *     synthetic images are smoke tests, never a verdict.
 *   - Node's OpenCV build is not the browser's WASM build. The ratio between
 *     sizes transfers; the absolute number does not.
 *
 * OpenCV.js: set OPENCV_JS to a local copy of
 * https://docs.opencv.org/4.9.0/opencv.js, otherwise it is downloaded once
 * into the OS temp directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const sharp = require('sharp');

const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, '.tmp');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'detectDocumentQuad.cjs');
const BLANK_FORM = path.join(ROOT, 'src', 'lib', 'recognition', 'assets', 'cagi-blank.png');

/** height / width of the sheet -- cagiTemplate.baseSize, 656 / 474. */
const EXPECTED_ASPECT_RATIO = 656 / 474;

/** The §7 live budget, and the size the shipped worker detects photos at. */
const LIVE_LONG_SIDE = 480;
const CAPTURE_LONG_SIDE = 1600;

const LIVE_RUNS = 20;
const CAPTURE_RUNS = 5;

/** Portrait frame, sheet tilted and inset so all four gates have something to say. */
function photoCorners(width, height) {
  return [
    [width * 0.115, height * 0.095],
    [width * 0.880, height * 0.130],
    [width * 0.905, height * 0.895],
    [width * 0.090, height * 0.870],
  ];
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const partial = `${destination}.download`;
      const file = fs.createWriteStream(partial);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(partial, destination);
          resolve(destination);
        });
      });
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function resolveOpenCvPath() {
  if (process.env.OPENCV_JS) {
    if (!fs.existsSync(process.env.OPENCV_JS)) {
      throw new Error(`OPENCV_JS points at a missing file: ${process.env.OPENCV_JS}`);
    }
    return process.env.OPENCV_JS;
  }

  const cached = path.join(os.tmpdir(), 'opencv-4.9.0.js');
  if (fs.existsSync(cached) && fs.statSync(cached).size > 5_000_000) {
    return cached;
  }

  console.log(`Downloading ${OPENCV_URL} -> ${cached}`);
  await download(OPENCV_URL, cached);
  return cached;
}

async function loadOpenCv(scriptPath) {
  const cv = require(scriptPath);
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  // Boxed -- cv is a thenable emscripten Module; never resolve a promise with it.
  return { cv };
}

/** Bundles the SHIPPED detector for Node, so this times the real code. */
function loadDetector() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  execSync(
    'npx esbuild src/lib/documentScanner/detectDocumentQuad.ts --bundle --platform=node ' +
    `--format=cjs --outfile="${BUNDLE_PATH.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(BUNDLE_PATH);
}

/**
 * A stand-in camera frame: the blank form warped into a tilted quad, composited
 * over a noisy mid-grey background so the Canny / Otsu / adaptive maps all have
 * real work to do rather than tracing a single clean silhouette.
 */
async function buildFrame(cv, longSide) {
  const height = longSide;
  const width = Math.round(longSide / EXPECTED_ASPECT_RATIO * 1.06);

  const sheetWidth = Math.round(width * 0.9);
  const sheetHeight = Math.round(sheetWidth * EXPECTED_ASPECT_RATIO);
  const raw = await sharp(BLANK_FORM)
    .resize(sheetWidth, sheetHeight, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  const sheet = cv.matFromArray(sheetHeight, sheetWidth, cv.CV_8UC1, raw);
  const ones = new cv.Mat(sheetHeight, sheetWidth, cv.CV_8UC1, new cv.Scalar(255));
  const sourceQuad = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    sheetWidth - 1, 0,
    sheetWidth - 1, sheetHeight - 1,
    0, sheetHeight - 1,
  ]);
  const destinationQuad = cv.matFromArray(4, 1, cv.CV_32FC2, photoCorners(width, height).flat());
  const transform = cv.getPerspectiveTransform(sourceQuad, destinationQuad);
  const warped = new cv.Mat();
  const mask = new cv.Mat();

  try {
    const size = new cv.Size(width, height);
    cv.warpPerspective(sheet, warped, transform, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.warpPerspective(ones, mask, transform, size, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));

    // Deterministic pseudo-noise: the same frame every run, so two runs of
    // this script are comparable.
    let seed = 20260827;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const background = 96 + (seed % 44);
      const value = mask.data[i] ? warped.data[i] : background;
      rgba[i * 4] = value;
      rgba[i * 4 + 1] = value;
      rgba[i * 4 + 2] = value;
      rgba[i * 4 + 3] = 255;
    }

    return { mat: cv.matFromArray(height, width, cv.CV_8UC4, rgba), width, height };
  } finally {
    mask.delete();
    warped.delete();
    transform.delete();
    destinationQuad.delete();
    sourceQuad.delete();
    ones.delete();
    sheet.delete();
  }
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

async function measure(cv, detector, longSide, runs, label) {
  const frame = await buildFrame(cv, longSide);

  try {
    const samples = [];
    let found = 0;
    let lastConfidence = null;
    let lastRejection = null;

    for (let run = 0; run < runs; run++) {
      const startedAt = process.hrtime.bigint();
      const detection = detector.detectDocumentQuadFromMat(
        cv,
        frame.mat,
        frame.width,
        frame.height,
        EXPECTED_ASPECT_RATIO,
      );
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      samples.push(elapsedMs);

      if (detection.quality) {
        found += 1;
        lastConfidence = detection.quality.confidence;
      } else {
        lastRejection = detection.rejection;
      }
    }

    const stats = summarise(samples);
    console.log('');
    console.log(`${label}  frame ${frame.width}x${frame.height}  (long side ${longSide}), N=${runs}`);
    // What the instrument was actually measuring -- a detector that bailed out
    // early would look fast and mean nothing (CLAUDE.md §2).
    console.log(
      `  quad found in ${found}/${runs} runs` +
      (lastConfidence !== null ? `, confidence ${lastConfidence.toFixed(3)}` : '') +
      (found === 0 ? `, rejection=${lastRejection}` : ''),
    );
    console.log(`  per call (ms): ${samples.map((value) => value.toFixed(1)).join(' ')}`);
    console.log(
      `  min ${stats.min.toFixed(1)}  median ${stats.median.toFixed(1)}  ` +
      `mean ${stats.mean.toFixed(1)}  max ${stats.max.toFixed(1)}`,
    );

    return stats;
  } finally {
    frame.mat.delete();
  }
}

(async () => {
  const detector = loadDetector();
  const scriptPath = await resolveOpenCvPath();
  const { cv } = await loadOpenCv(scriptPath);

  const live = await measure(cv, detector, LIVE_LONG_SIDE, LIVE_RUNS, 'LIVE   (§7 budget)');
  const capture = await measure(cv, detector, CAPTURE_LONG_SIDE, CAPTURE_RUNS, 'CAPTURE (shipped)');

  console.log('');
  console.log(
    `median ratio capture/live = ${(capture.median / live.median).toFixed(1)}x ` +
    `(pixel ratio ${((CAPTURE_LONG_SIDE / LIVE_LONG_SIDE) ** 2).toFixed(1)}x)`,
  );
  console.log('Detector cost only -- not an fps figure, and the frame is synthetic.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
