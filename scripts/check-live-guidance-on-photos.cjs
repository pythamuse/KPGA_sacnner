// The merge test: run the SHIPPED reducer over the SHIPPED detector's output on
// the REAL photos and check the two things §13.7 says regressed -- `ready` is
// reachable, and nextReadyStreak actually builds. Unit tests assert this on
// hand-built inputs; this asserts it on the frames that produced the finding.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execSync } = require('child_process');
const ROOT = process.env.KPGA_ROOT || 'C:/Users/night/Desktop/바이브코딩/도박예방';
const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
const SP = process.argv[2];
const TMP = path.join(os.tmpdir(), 'm5-merged'); fs.mkdirSync(TMP, { recursive: true });
for (const [src, out] of [['src/lib/documentScanner/detectDocumentQuad.ts', 'detect.cjs'],
                          ['src/lib/documentScanner/captureGuidance.ts', 'guidance.cjs']]) {
  const dest = path.join(TMP, out).split(String.fromCharCode(92)).join("/");
  execSync(`npx esbuild "${src}" --bundle --platform=node --format=cjs --outfile="${dest}"`,
    { cwd: ROOT, stdio: 'pipe' });
}
const cv = require(path.join(os.tmpdir(), 'opencv-4.9.0.js'));
const detector = require(path.join(TMP, 'detect.cjs'));
const g = require(path.join(TMP, 'guidance.cjs'));
const LIVE = 480; const ASPECT = 656 / 474;

(async () => {
  const t0 = Date.now(); while (!cv.Mat && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 10));
  console.log('LIVE_EXPOSURE_HINT_ENABLED =', g.LIVE_EXPOSURE_HINT_ENABLED,
              '· MIN_SAMPLES =', g.LIVE_EXPOSURE_MIN_SAMPLES,
              '· WARN =', g.LIVE_DYNAMIC_RANGE_WARN);
  console.log('');
  console.log('사진            영역   range  표본    판정        streak(2→)  문구');
  let quadFrames = 0, warned = 0, readyFrames = 0, streakOk = 0;
  for (const form of [{ d: 'set19/cagi', p: 'cagi' }, { d: 'set19/sat', p: 'sat' }]) {
    for (let s = 1; s <= 19; s++) {
      const f = path.join(SP, form.d, `${form.p}-p${s}.jpg`);
      if (!fs.existsSync(f)) continue;
      const meta = await sharp(f).metadata();
      const sc = LIVE / Math.max(meta.width, meta.height);
      const w = Math.round(meta.width * sc), h = Math.round(meta.height * sc);
      const pv = await sharp(f).resize(w, h).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const rgba = new Uint8ClampedArray(pv.data);
      const mat = cv.matFromImageData({ data: rgba, width: w, height: h });
      let quality = null, rejection = null;
      try { const d = detector.detectDocumentQuadFromMat(cv, mat, w, h, ASPECT); quality = d.quality; rejection = d.rejection; }
      catch (e) { quality = null; }
      mat.delete();
      const exposure = g.measureFrameExposureInRegion(rgba, w, h, quality ? quality.points : null);
      const status = g.evaluateCaptureGuidance({ quality, rejection, frameWidth: w, frameHeight: h, exposure });
      const streak = g.nextReadyStreak(2, status);
      if (!quality) continue;              // only quad-locked frames reach the branch
      quadFrames++;
      if (status.code === 'exposure') warned++;
      if (status.level === 'ready') { readyFrames++; if (streak === 3) streakOk++; }
      console.log(`${(form.p + '-p' + s).padEnd(15)} ${(exposure ? exposure.region : '-').padEnd(6)} ${String(exposure ? exposure.dynamicRange : -1).padStart(5)} ${String(exposure ? exposure.sampleCount : 0).padStart(6)}  ${status.code.padEnd(12)} ${String(streak).padStart(9)}  ${status.message}`);
    }
  }
  console.log('');
  console.log(`사각형 검출 프레임 ${quadFrames}개`);
  console.log(`  "어둡습니다" 발화 : ${warned}   (기대 0 — 기본 꺼짐)`);
  console.log(`  ready 도달        : ${readyFrames}`);
  console.log(`  streak 증가       : ${streakOk}/${readyFrames}   (기대: 전부 — §13.7의 회귀)`);
  const pass = warned === 0 && readyFrames > 0 && streakOk === readyFrames;
  console.log('');
  console.log(pass ? '판정: 통과' : '판정: 실패');
  process.exit(pass ? 0 : 1);
})();
