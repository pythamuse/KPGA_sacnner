#!/usr/bin/env node
/**
 * Generates the committed ORB template features for both blank forms.
 *
 *   node scripts/generate-orb-template.cjs
 *
 * Reads  src/lib/recognition/assets/{cagi,satisfaction}-blank.png
 * Writes src/lib/documentScanner/orbTemplate.{cagi,satisfaction}.json
 *
 * Each blank is resized (fill, aspect ignored -- the warp destination frame
 * is the same stretch) to 1422x1968 = template baseSize 474x656 x
 * PERSPECTIVE_CORRECTION_SCALE 3, converted to grayscale, and run through
 * ORB(3000). The JSON carries keypoint coordinates plus the raw Uint8
 * descriptor matrix (rows x 32 bytes) as base64.
 *
 * OpenCV.js is the exact build the app loads in the worker
 * (https://docs.opencv.org/4.9.0/opencv.js). It is downloaded once into the
 * OS temp directory; set OPENCV_JS to a local copy to skip the download.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
const TEMPLATE_WIDTH = 1422;
const TEMPLATE_HEIGHT = 1968;
const ORB_FEATURE_COUNT = 3000;
const MAX_JSON_BYTES = 400 * 1024;

const ROOT = path.resolve(__dirname, '..');
const FORMS = [
  {
    name: 'cagi',
    asset: path.join(ROOT, 'src', 'lib', 'recognition', 'assets', 'cagi-blank.png'),
    output: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.cagi.json'),
  },
  {
    name: 'satisfaction',
    asset: path.join(ROOT, 'src', 'lib', 'recognition', 'assets', 'satisfaction-blank.png'),
    output: path.join(ROOT, 'src', 'lib', 'documentScanner', 'orbTemplate.satisfaction.json'),
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
  // reliably in Node, and the pending setTimeout also keeps the event loop
  // alive -- without it Node exits silently mid-initialisation.
  const startedAt = Date.now();
  while (!cv.Mat && Date.now() - startedAt < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!cv.Mat) throw new Error('OpenCV runtime did not initialise.');
  // Boxed: `cv` is an emscripten Module with a `then` method, so any promise
  // that resolves to it directly never settles.
  return { cv };
}

async function generateForForm(cv, form) {
  const raw = await sharp(form.asset)
    .resize(TEMPLATE_WIDTH, TEMPLATE_HEIGHT, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  if (raw.length !== TEMPLATE_WIDTH * TEMPLATE_HEIGHT) {
    throw new Error(`Unexpected raw buffer size ${raw.length} for ${form.name}.`);
  }

  const gray = cv.matFromArray(TEMPLATE_HEIGHT, TEMPLATE_WIDTH, cv.CV_8UC1, raw);
  const orb = new cv.ORB(ORB_FEATURE_COUNT);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const emptyMask = new cv.Mat();

  try {
    orb.detectAndCompute(gray, emptyMask, keypoints, descriptors);

    const rows = descriptors.rows;
    if (rows === 0) throw new Error(`ORB found no features on ${form.name} blank.`);
    if (descriptors.cols !== 32) {
      throw new Error(`Descriptor width ${descriptors.cols} != 32 for ${form.name}.`);
    }
    if (keypoints.size() !== rows) {
      throw new Error(`Keypoints ${keypoints.size()} != descriptor rows ${rows} for ${form.name}.`);
    }

    const points = [];
    for (let i = 0; i < rows; i++) {
      const keypoint = keypoints.get(i);
      // 0.01px precision keeps the JSON small; RANSAC works at 4px.
      points.push([
        Math.round(keypoint.pt.x * 100) / 100,
        Math.round(keypoint.pt.y * 100) / 100,
      ]);
    }

    const descriptorBytes = Buffer.from(descriptors.data.slice(0, rows * 32));
    const template = {
      width: TEMPLATE_WIDTH,
      height: TEMPLATE_HEIGHT,
      points,
      descriptors: descriptorBytes.toString('base64'),
    };

    const json = JSON.stringify(template);
    if (json.length > MAX_JSON_BYTES) {
      throw new Error(`${form.name} template JSON is ${json.length} bytes (> ${MAX_JSON_BYTES}).`);
    }

    fs.writeFileSync(form.output, json);
    console.log(
      `${form.name}: ${rows} keypoints, descriptors ${descriptorBytes.length} bytes, ` +
      `json ${(json.length / 1024).toFixed(1)}KB -> ${path.relative(ROOT, form.output)}`,
    );
  } finally {
    emptyMask.delete();
    descriptors.delete();
    keypoints.delete();
    orb.delete();
    gray.delete();
  }
}

(async () => {
  const scriptPath = await resolveOpenCvPath();
  const { cv } = await loadOpenCv(scriptPath);
  for (const form of FORMS) {
    await generateForForm(cv, form);
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
