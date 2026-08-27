#!/usr/bin/env node
/**
 * Round-trip integration check for orbAlign.ts. Standalone Node on purpose:
 * vitest hangs indefinitely trying to transform the 10MB opencv.js bundle,
 * so anything that needs cv runs as a plain script (same rule as
 * tests/_harness-photo-quality.ts).
 *
 *   node scripts/check-orb-align.cjs
 *
 * What it proves: for each form, the blank template warped by a KNOWN
 * synthetic perspective homography is re-registered by alignToTemplate, and
 * the recovered photo->template homography undoes the synthetic warp to
 * within CORNER_TOLERANCE_PX at all four template corners.
 *
 * What it does NOT prove: accuracy on real photos. That is the central
 * measurement checkout's job (CLAUDE.md §2 -- synthetic images are smoke
 * tests only).
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
const CORNER_TOLERANCE_PX = 3;

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, '.tmp');
const BUNDLE_PATH = path.join(BUNDLE_DIR, 'orbAlign.cjs');

// The synthetic "photo": portrait frame with the page tilted and inset, so
// the warp includes perspective foreshortening, not just an affine squeeze.
const PHOTO_WIDTH = 1200;
const PHOTO_HEIGHT = 1600;
const PHOTO_CORNERS = [
  [150, 120],   // top-left
  [1050, 180],  // top-right
  [980, 1500],  // bottom-right
  [90, 1440],   // bottom-left
];

const FORMS = [
  {
    name: 'cagi',
    asset: path.join(ROOT, 'src', 'lib', 'recognition', 'assets', 'cagi-blank.png'),
    template: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.cagi.json'),
  },
  {
    name: 'satisfaction',
    asset: path.join(ROOT, 'src', 'lib', 'recognition', 'assets', 'satisfaction-blank.png'),
    template: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.satisfaction.json'),
  },
];

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
  // Poll instead of awaiting onRuntimeInitialized: the hook does not fire
  // reliably in Node, and the pending setTimeout keeps the event loop alive.
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  // Boxed -- cv is a thenable emscripten Module; never resolve a promise with it.
  return { cv };
}

/** Bundles orbAlign.ts for Node and requires it, so this checks the shipped code. */
function loadOrbAlign() {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  execSync(
    'npx esbuild src/lib/documentScanner/orbAlign.ts --bundle --platform=node ' +
    `--format=cjs --outfile="${BUNDLE_PATH.replace(/\\/g, '/')}"`,
    { cwd: ROOT, stdio: 'pipe' },
  );
  return require(BUNDLE_PATH);
}

async function checkForm(cv, orbAlign, form) {
  const template = JSON.parse(fs.readFileSync(form.template, 'utf8'));

  const raw = await sharp(form.asset)
    .resize(template.width, template.height, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();
  const templateGray = cv.matFromArray(template.height, template.width, cv.CV_8UC1, raw);

  const templateCorners = [
    [0, 0],
    [template.width - 1, 0],
    [template.width - 1, template.height - 1],
    [0, template.height - 1],
  ];

  const sourceQuad = cv.matFromArray(4, 1, cv.CV_32FC2, templateCorners.flat());
  const destinationQuad = cv.matFromArray(4, 1, cv.CV_32FC2, PHOTO_CORNERS.flat());
  const syntheticTransform = cv.getPerspectiveTransform(sourceQuad, destinationQuad);
  const syntheticH = Array.from(syntheticTransform.data64F.slice(0, 9));
  const photo = new cv.Mat();

  try {
    cv.warpPerspective(
      templateGray,
      photo,
      syntheticTransform,
      new cv.Size(PHOTO_WIDTH, PHOTO_HEIGHT),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255),
    );

    const startedAt = Date.now();
    const alignment = orbAlign.alignToTemplate(cv, photo, template);
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `${form.name}: goodMatches=${alignment.goodMatches} inliers=${alignment.inliers} ` +
      `ratio=${alignment.inlierRatio.toFixed(3)} homography=${alignment.homography ? 'yes' : 'null'} ` +
      `(${elapsedMs}ms)`,
    );

    if (!alignment.homography) {
      console.error(`${form.name}: FAIL -- no homography recovered.`);
      return false;
    }

    // Round trip: template corner -> (known synthetic H) -> photo point ->
    // (recovered H) -> should land back on the template corner.
    let pass = true;
    for (const [cornerX, cornerY] of templateCorners) {
      const [photoX, photoY] = orbAlign.applyHomography(syntheticH, cornerX, cornerY);
      const [backX, backY] = orbAlign.applyHomography(alignment.homography, photoX, photoY);
      const error = Math.hypot(backX - cornerX, backY - cornerY);
      const ok = error <= CORNER_TOLERANCE_PX;
      if (!ok) pass = false;
      console.log(
        `  corner (${cornerX}, ${cornerY}) -> photo (${photoX.toFixed(1)}, ${photoY.toFixed(1)}) ` +
        `-> back (${backX.toFixed(2)}, ${backY.toFixed(2)})  error=${error.toFixed(2)}px ` +
        `${ok ? 'ok' : `FAIL (> ${CORNER_TOLERANCE_PX}px)`}`,
      );
    }

    return pass;
  } finally {
    photo.delete();
    syntheticTransform.delete();
    destinationQuad.delete();
    sourceQuad.delete();
    templateGray.delete();
  }
}

(async () => {
  const orbAlign = loadOrbAlign();
  const scriptPath = await resolveOpenCvPath();
  const { cv } = await loadOpenCv(scriptPath);

  let allPass = true;
  for (const form of FORMS) {
    const pass = await checkForm(cv, orbAlign, form);
    allPass = allPass && pass;
  }

  console.log(allPass ? 'PASS: round-trip within tolerance on both forms.' : 'FAIL');
  process.exit(allPass ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
