#!/usr/bin/env node
/**
 * The measurement the M5 agent could not make, because its worktree has no
 * photos: what does `dynamicRange` read at LIVE PREVIEW SCALE?
 *
 * CAPTURE_GUIDANCE §11.3's split (productive 155-182, unproductive 61-108) and
 * therefore LIVE_DYNAMIC_RANGE_WARN = 130 come from WARPED FINALS at full
 * resolution. The live overlay never sees those. It sees a ~480px-long-side
 * frame of the UNWARPED scene, and reads the quad's interior out of it.
 *
 * Two things could move the number between those, in opposite directions:
 *   - downscaling averages pixels, which pulls both tails inward and SHRINKS
 *     the range;
 *   - the unwarped frame is the whole sheet plus perspective, and the quad
 *     interior may catch a sliver of dark desk, which WIDENS it.
 * Which one wins is not deducible. So measure it.
 *
 *   node scripts/check-preview-exposure.cjs <photo-dir>
 *
 * <photo-dir> holds set19/{cagi,sat} (originals) and prod19-{cagi,sat} (warped
 * finals). Those are student responses -- CLAUDE.md §6, they never enter the
 * repository. Pass an absolute path to a scratchpad copy.
 *
 * Runs the SHIPPED detector and the SHIPPED exposure code (from the agent's
 * branch) so this scores the real thing, not a re-implementation.
 *
 * NOT MEASURED, and must not be quoted as if it were: a real camera preview.
 * These are downscales of the captured stills. A phone's preview stream has its
 * own gain, white balance and compression, and the still that follows is often
 * exposed differently from the frames before it. This isolates the RASTER-SCALE
 * term only. It cannot retire the device session.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const SP = process.argv[2];
if (!SP) throw new Error('usage: node preview-exposure.cjs <scratchpad>');

// Absolute: this script lives in the scratchpad, so Node resolves bare
// specifiers against THAT directory, not the repo it is measuring.
const ROOT = process.env.KPGA_ROOT || path.resolve(__dirname, '..');
const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
const WT = path.join(ROOT, '.claude', 'worktrees', 'agent-a799b5327d00ae8c1');
const TMP = path.join(os.tmpdir(), 'm5-preview-exposure');
const OPENCV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';

/** The size the shipped worker detects live frames at. */
const LIVE_LONG_SIDE = 480;
const EXPECTED_ASPECT = { cagi: 656 / 474, sat: 656 / 474 };

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, destination).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const partial = destination + '.download';
      const file = fs.createWriteStream(partial);
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(partial, destination); resolve(destination); }));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function resolveOpenCv() {
  if (process.env.OPENCV_JS && fs.existsSync(process.env.OPENCV_JS)) return process.env.OPENCV_JS;
  const cached = path.join(os.tmpdir(), 'opencv-4.9.0.js');
  if (fs.existsSync(cached) && fs.statSync(cached).size > 5_000_000) return cached;
  console.error('downloading opencv.js ...');
  await download(OPENCV_URL, cached);
  return cached;
}

async function loadOpenCv(scriptPath) {
  const cv = require(scriptPath);
  const start = Date.now();
  while (!cv.Mat && Date.now() - start < 30_000) await new Promise((r) => setTimeout(r, 10));
  if (!cv.Mat) throw new Error('OpenCV did not initialise');
  return { cv }; // boxed -- cv is a thenable emscripten Module
}

function bundle(srcRel, outName, cwd) {
  fs.mkdirSync(TMP, { recursive: true });
  const out = path.join(TMP, outName);
  execSync(
    `npx esbuild "${srcRel}" --bundle --platform=node --format=cjs --outfile="${out.replace(/\\/g, '/')}"`,
    { cwd, stdio: 'pipe' },
  );
  return require(out);
}

/** p95 - p05 over 8-bit greys, markDensity's nearest-rank index rule. */
function dynamicRangeOf(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]] += 1;
  const at = (f) => {
    const idx = Math.min(gray.length - 1, Math.max(0, Math.round((gray.length - 1) * f)));
    let c = 0;
    for (let b = 0; b < 256; b++) { c += hist[b]; if (c > idx) return b; }
    return 255;
  };
  const p05 = at(0.05);
  const p95 = at(0.95);
  return { p05, p95, dynamicRange: p95 - p05 };
}

(async () => {
  const cvPath = await resolveOpenCv();
  const { cv } = await loadOpenCv(cvPath);
  global.cv = cv;

  const detector = bundle('src/lib/documentScanner/detectDocumentQuad.ts', 'detect.cjs', ROOT);
  const guidance = bundle('src/lib/documentScanner/captureGuidance.ts', 'guidance.cjs', WT);

  console.log('LIVE_DYNAMIC_RANGE_WARN as shipped =', guidance.LIVE_DYNAMIC_RANGE_WARN);
  console.log('');

  const forms = [
    { key: 'cagi', orig: 'set19/cagi', final: 'prod19-cagi', prefix: 'cagi' },
    { key: 'sat', orig: 'set19/sat', final: 'prod19-sat', prefix: 'sat' },
  ];

  const rows = [];
  for (let student = 1; student <= 19; student++) {
    const row = { student };
    for (const form of forms) {
      const origPath = path.join(SP, form.orig, `${form.prefix}-p${student}.jpg`);
      const finalPath = path.join(SP, form.final, `${form.prefix}-p${student}.jpg`);
      if (!fs.existsSync(origPath) || !fs.existsSync(finalPath)) { row[form.key] = null; continue; }

      // --- FINAL, full resolution: reproduces what §11.3 measured -----------
      const fin = await sharp(finalPath).grayscale().raw().toBuffer({ resolveWithObject: true });
      const finalRange = dynamicRangeOf(fin.data);

      // --- PREVIEW: original downscaled to the live long side ---------------
      const meta = await sharp(origPath).metadata();
      const scale = LIVE_LONG_SIDE / Math.max(meta.width, meta.height);
      const w = Math.round(meta.width * scale);
      const h = Math.round(meta.height * scale);
      const pv = await sharp(origPath).resize(w, h).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      const rgba = new Uint8ClampedArray(pv.data);

      // shipped detector, on the frame the worker would receive
      const mat = cv.matFromImageData({ data: rgba, width: w, height: h });
      let quad = null;
      let rejection = null;
      try {
        const det = detector.detectDocumentQuadFromMat(cv, mat, w, h, EXPECTED_ASPECT[form.key]);
        quad = det && det.quality ? det.quality.points : null;
        rejection = det ? det.rejection : null;
      } catch (e) {
        quad = null;
        rejection = "threw:" + e.message.slice(0, 30);
      }
      mat.delete();

      // shipped exposure code, quad interior (or guide-rect fallback)
      const sample = guidance.measureFrameExposureInRegion(rgba, w, h, quad);

      // whole downscaled frame, no region test -- isolates the region term
      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = Math.round(0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]);
      }
      const wholeFrame = dynamicRangeOf(gray);

      row[form.key] = {
        finalRange: finalRange.dynamicRange,
        finalP05: finalRange.p05,
        finalP95: finalRange.p95,
        previewRange: sample ? sample.dynamicRange : null,
        previewP05: sample ? sample.p05 : null,
        previewP95: sample ? sample.p95 : null,
        region: sample ? sample.region : 'none',
        rejection,
        samples: sample ? sample.sampleCount : 0,
        stride: sample ? sample.stride : 0,
        wholeFrameRange: wholeFrame.dynamicRange,
        frame: `${w}x${h}`,
      };
    }
    rows.push(row);
    process.stderr.write(`p${student} `);
  }
  process.stderr.write('\n\n');

  fs.writeFileSync(path.join(SP, 'preview-exposure.json'), JSON.stringify(rows, null, 1));

  const line = (r, k) => {
    const c = r[k];
    if (!c) return '        --                    ';
    return `${String(c.finalRange).padStart(5)} ${String(c.previewRange ?? -1).padStart(6)}` +
      ` ${c.region.padEnd(5)} ${String(c.samples).padStart(6)} ${String(c.wholeFrameRange).padStart(5)}`;
  };

  console.log('              ------------- CAGI --------------   --------- SATISFACTION ---------');
  console.log('학생          최종  프리뷰 영역   표본   전체프레임   최종  프리뷰 영역   표본   전체프레임');
  rows.forEach((r) => console.log(
    `p${String(r.student).padEnd(3)}  ${line(r, 'cagi')}   ${line(r, 'sat')}`,
  ));

  // The §11.3 statistic is min across the two forms.
  console.log('');
  console.log('학생   최종(min)  프리뷰(min)   차이');
  const pairs = [];
  rows.forEach((r) => {
    if (!r.cagi || !r.sat || r.cagi.previewRange == null || r.sat.previewRange == null) return;
    const f = Math.min(r.cagi.finalRange, r.sat.finalRange);
    const p = Math.min(r.cagi.previewRange, r.sat.previewRange);
    pairs.push({ student: r.student, f, p });
    console.log(`p${String(r.student).padEnd(3)} ${String(f).padStart(9)} ${String(p).padStart(11)} ${String(p - f).padStart(7)}`);
  });

  const diffs = pairs.map((x) => x.p - x.f).sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  console.log('');
  console.log(`프리뷰 - 최종 : 중앙값 ${med}, 범위 ${diffs[0]} .. ${diffs[diffs.length - 1]}`);
  console.log(`프리뷰 범위   : ${Math.min(...pairs.map((x) => x.p))} .. ${Math.max(...pairs.map((x) => x.p))}`);
  console.log(`최종 범위     : ${Math.min(...pairs.map((x) => x.f))} .. ${Math.max(...pairs.map((x) => x.f))}`);
  const warn = guidance.LIVE_DYNAMIC_RANGE_WARN;
  const flagged = pairs.filter((x) => x.p < warn);
  console.log('');
  console.log(`문턱 ${warn} 을 프리뷰 값에 그대로 적용하면: ${flagged.length}/${pairs.length}명이 "어둡다" 경고`);
  console.log(`  경고 대상: ${flagged.map((x) => 'p' + x.student).join(' ')}`);
})();
